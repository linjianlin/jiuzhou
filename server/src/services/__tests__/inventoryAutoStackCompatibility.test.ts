/**
 * inventory 自动堆叠旧数据兼容回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证新入包的普通可堆叠物品，能够和历史空语义旧实例自动合并。
 * - 做什么：锁住“自动堆叠后会顺手把旧实例规范回当前标准字段”的行为，避免兼容只修查询不修数据。
 * - 不做什么：不连接真实数据库，不执行项目 test 命令，也不覆盖装备等不可堆叠分支。
 *
 * 输入/输出：
 * - 输入：mock 的 `item_instance`/`inventory` 查询结果，以及 `addItemToInventory`、`moveItemInstanceToBagWithStacking` 调用。
 * - 输出：调用结果、内存态实例数量与字段归一化结果。
 *
 * 数据流/状态流：
 * - 测试通过 mock `database.query` 构造旧数据实例；
 * - 业务函数先按兼容口径锁定可堆叠实例，再执行数量合并；
 * - 最后断言数量、`bind_type` 与空语义字段都被收敛到当前标准格式。
 *
 * 关键边界条件与坑点：
 * 1. 旧实例里的 `bind_type='' / metadata::text='null' / quality='' / quality_rank=0` 都应被视为普通堆叠实例，而不是继续拆成孤立堆。
 * 2. 回包路径必须和新增入包走同一口径，否则邮件/交易回收的旧实例仍会和新掉落分裂成两组。
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import * as database from "../../config/database.js";
import * as inventoryMutex from "../inventoryMutex.js";
import * as inventoryHelpers from "../inventory/shared/helpers.js";
import {
  addItemToInventory,
  moveItem,
  moveItemInstanceToBagWithStacking,
} from "../inventory/bag.js";

type QueryParams = Array<string | number | null> | undefined;

type MockStackRow = {
  id: number;
  owner_user_id: number;
  owner_character_id: number;
  item_def_id: string;
  qty: number;
  location: "bag" | "mail" | "warehouse";
  location_slot: number | null;
  bind_type: string;
  quality: string | null;
  quality_rank: number | null;
  metadata_text: string | null;
};

type StaticItemDef = NonNullable<ReturnType<typeof inventoryHelpers.getStaticItemDef>>;

const normalizeBindType = (value: string | null): string => {
  if (typeof value !== "string") {
    return "none";
  }
  const normalized = value.trim().toLowerCase();
  return normalized || "none";
};

const isPlainStackRow = (row: MockStackRow): boolean => {
  const normalizedMetadata = row.metadata_text?.trim().toLowerCase() ?? null;
  const normalizedQuality = row.quality?.trim() ?? null;
  const normalizedQualityRank = Number(row.quality_rank);
  return (
    (normalizedMetadata === null || normalizedMetadata.length === 0 || normalizedMetadata === "null") &&
    (normalizedQuality === null || normalizedQuality.length === 0) &&
    (row.quality_rank === null ||
      !Number.isFinite(normalizedQualityRank) ||
      normalizedQualityRank <= 0)
  );
};

const applyPlainCanonicalFields = (row: MockStackRow, bindType: string): void => {
  row.bind_type = bindType;
  row.quality = null;
  row.quality_rank = null;
  row.metadata_text = null;
};

const installCommonMocks = (t: TestContext, rows: MockStackRow[]): void => {
  const staticItemDef = {
    id: "mat-9999",
    enabled: true,
    stack_max: 9999,
    bind_type: "none",
    name: "上古玄铁",
    category: "material",
    sub_category: "ore",
    quality: "common",
    icon: "",
  } as StaticItemDef;

  t.mock.method(inventoryMutex, "lockCharacterInventoryMutex", async () => {});
  t.mock.method(inventoryHelpers, "getStaticItemDef", (itemDefIdRaw: string | number) => {
    return String(itemDefIdRaw) === "mat-9999" ? staticItemDef : null;
  });

  t.mock.method(database, "query", async (sql: string, params?: QueryParams) => {
    if (sql.includes("FROM inventory i")) {
      return {
        rows: [
          {
            bag_capacity: 30,
            warehouse_capacity: 1000,
            bag_used: rows.filter((row) => row.location === "bag").length,
            warehouse_used: 0,
          },
        ],
      };
    }

    if (
      sql.includes("SELECT id, qty") &&
      sql.includes("FROM item_instance") &&
      sql.includes("FOR UPDATE")
    ) {
      const characterId = Number(params?.[0]);
      const itemDefId = String(params?.[1] ?? "");
      const location = String(params?.[2] ?? "");
      const stackMax = Number(params?.[3]);
      const bindType = String(params?.[4] ?? "");
      const excludedId =
        params !== undefined && params.length > 5 ? Number(params[5]) : null;
      return {
        rows: rows
          .filter((row) => row.owner_character_id === characterId)
          .filter((row) => row.item_def_id === itemDefId)
          .filter((row) => row.location === location)
          .filter((row) => row.qty < stackMax)
          .filter((row) => normalizeBindType(row.bind_type) === bindType)
          .filter((row) => isPlainStackRow(row))
          .filter((row) => excludedId === null || row.id !== excludedId)
          .sort((left, right) => right.qty - left.qty || left.id - right.id)
          .map((row) => ({
            id: row.id,
            qty: row.qty,
          })),
      };
    }

    if (sql.includes("SELECT") && sql.includes("metadata::text AS metadata_text")) {
      const itemInstanceId = Number(params?.[0]);
      const row = rows.find((entry) => entry.id === itemInstanceId);
      assert.ok(row, `未找到来源实例 ${itemInstanceId}`);
      return {
        rows: [
          {
            id: row.id,
            owner_user_id: row.owner_user_id,
            owner_character_id: row.owner_character_id,
            item_def_id: row.item_def_id,
            qty: row.qty,
            quality: row.quality,
            quality_rank: row.quality_rank,
            metadata_text: row.metadata_text,
            location: row.location,
            location_slot: row.location_slot,
            bind_type: row.bind_type,
          },
        ],
      };
    }

    if (sql.includes("UPDATE item_instance") && sql.includes("SET qty = qty + $1")) {
      const addQty = Number(params?.[0]);
      const bindType = String(params?.[1] ?? "");
      const itemId = Number(params?.[2]);
      const row = rows.find((entry) => entry.id === itemId);
      assert.ok(row, `未找到承载实例 ${itemId}`);
      row.qty += addQty;
      applyPlainCanonicalFields(row, bindType);
      return { rows: [] };
    }

    if (sql.includes("DELETE FROM item_instance WHERE id = $1")) {
      const itemId = Number(params?.[0]);
      const index = rows.findIndex((entry) => entry.id === itemId);
      assert.notEqual(index, -1, `未找到待删除实例 ${itemId}`);
      rows.splice(index, 1);
      return { rows: [] };
    }

    if (
      sql.includes("UPDATE item_instance") &&
      sql.includes("SET location = 'bag'") &&
      sql.includes("RETURNING id")
    ) {
      const nextSlot = Number(params?.[0]);
      const bindType = String(params?.[1] ?? "");
      const itemId = Number(params?.[2]);
      const row = rows.find((entry) => entry.id === itemId);
      assert.ok(row, `未找到待回包实例 ${itemId}`);
      row.location = "bag";
      row.location_slot = nextSlot;
      row.bind_type = bindType;
      if (sql.includes("metadata = NULL")) {
        applyPlainCanonicalFields(row, bindType);
      }
      return { rows: [{ id: row.id }] };
    }

    if (sql.includes("UPDATE item_instance") && sql.includes("SET qty = $1")) {
      const nextQty = Number(params?.[0]);
      const itemId = Number(params?.[1]);
      const row = rows.find((entry) => entry.id === itemId);
      assert.ok(row, `未找到待更新数量实例 ${itemId}`);
      row.qty = nextQty;
      return { rows: [] };
    }

    if (sql.includes("SELECT location_slot FROM item_instance")) {
      const location = String(params?.[1] ?? "");
      return {
        rows: rows
          .filter((row) => row.location === location && row.location_slot !== null)
          .map((row) => ({ location_slot: row.location_slot })),
      };
    }

    assert.fail(`未预期的 SQL: ${sql}`);
  });
};

test("新掉落的普通可堆叠物品应能和旧空语义实例自动堆叠", async (t) => {
  const rows: MockStackRow[] = [
    {
      id: 11,
      owner_user_id: 2001,
      owner_character_id: 1001,
      item_def_id: "mat-9999",
      qty: 9997,
      location: "bag",
      location_slot: 3,
      bind_type: " NONE ",
      quality: "",
      quality_rank: 0,
      metadata_text: "null",
    },
  ];
  installCommonMocks(t, rows);

  const result = await addItemToInventory(1001, 2001, "mat-9999", 2, {
    location: "bag",
    obtainedFrom: "battle_drop",
  });

  assert.deepEqual(result, {
    success: true,
    message: "添加成功",
    itemIds: [11],
  });
  assert.deepEqual(rows, [
    {
      id: 11,
      owner_user_id: 2001,
      owner_character_id: 1001,
      item_def_id: "mat-9999",
      qty: 9999,
      location: "bag",
      location_slot: 3,
      bind_type: "none",
      quality: null,
      quality_rank: null,
      metadata_text: null,
    },
  ]);
});

test("邮件回包时也应与旧空语义背包实例自动堆叠", async (t) => {
  const rows: MockStackRow[] = [
    {
      id: 21,
      owner_user_id: 2002,
      owner_character_id: 1002,
      item_def_id: "mat-9999",
      qty: 9998,
      location: "bag",
      location_slot: 0,
      bind_type: "",
      quality: "",
      quality_rank: 0,
      metadata_text: "null",
    },
    {
      id: 22,
      owner_user_id: 2002,
      owner_character_id: 1002,
      item_def_id: "mat-9999",
      qty: 1,
      location: "mail",
      location_slot: null,
      bind_type: "none",
      quality: null,
      quality_rank: null,
      metadata_text: null,
    },
  ];
  installCommonMocks(t, rows);

  const result = await moveItemInstanceToBagWithStacking(1002, 22, {
    expectedSourceLocation: "mail",
    expectedOwnerUserId: 2002,
  });

  assert.deepEqual(result, {
    success: true,
    message: "移动成功",
    itemId: 21,
  });
  assert.deepEqual(rows, [
    {
      id: 21,
      owner_user_id: 2002,
      owner_character_id: 1002,
      item_def_id: "mat-9999",
      qty: 9999,
      location: "bag",
      location_slot: 0,
      bind_type: "none",
      quality: null,
      quality_rank: null,
      metadata_text: null,
    },
  ]);
});

test("仓库取回时也应复用同一套旧数据兼容堆叠口径", async (t) => {
  const rows: MockStackRow[] = [
    {
      id: 31,
      owner_user_id: 2003,
      owner_character_id: 1003,
      item_def_id: "mat-9999",
      qty: 9998,
      location: "bag",
      location_slot: 1,
      bind_type: "none",
      quality: "",
      quality_rank: 0,
      metadata_text: "null",
    },
    {
      id: 32,
      owner_user_id: 2003,
      owner_character_id: 1003,
      item_def_id: "mat-9999",
      qty: 1,
      location: "warehouse",
      location_slot: 4,
      bind_type: "none",
      quality: null,
      quality_rank: null,
      metadata_text: null,
    },
  ];
  installCommonMocks(t, rows);

  const result = await moveItem(1003, 32, "bag");

  assert.deepEqual(result, {
    success: true,
    message: "移动成功",
  });
  assert.deepEqual(rows, [
    {
      id: 31,
      owner_user_id: 2003,
      owner_character_id: 1003,
      item_def_id: "mat-9999",
      qty: 9999,
      location: "bag",
      location_slot: 1,
      bind_type: "none",
      quality: null,
      quality_rank: null,
      metadata_text: null,
    },
  ]);
});
