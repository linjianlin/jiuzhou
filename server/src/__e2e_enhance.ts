import { createItem } from './services/itemService.js';
import { query } from './config/database.js';

type Json = Record<string, unknown>;
type E2eLog = Record<string, unknown>;

const base = process.env.E2E_BASE_URL || 'http://localhost:6012';

const parseJsonOrThrow = (status: number, text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非JSON响应 ${status}: ${text.slice(0, 200)}`);
  }
};

const getJson = async (url: string, token?: string): Promise<any> => {
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const text = await res.text();
  const json = parseJsonOrThrow(res.status, text);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
};

const postJson = async (url: string, body: Json, token?: string): Promise<any> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = parseJsonOrThrow(res.status, text);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
};

const findInBag = async (token: string, predicate: (it: any) => boolean): Promise<any | null> => {
  const list = await getJson(`${base}/api/inventory/items?location=bag&page=1&pageSize=200`, token);
  const items = Array.isArray(list?.data?.items) ? list.data.items : [];
  return items.find(predicate) ?? null;
};

const must = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(message);
};

const pickNum = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(task: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await task();
    } catch (e) {
      lastError = e;
      if (i < attempts) await sleep(80 * i);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('retry failed');
};

const postInventory = async (
  path: string,
  body: Json,
  token: string,
): Promise<{ ok: boolean; payload: any }> => {
  try {
    const payload = await postJson(`${base}${path}`, body, token);
    return { ok: true, payload };
  } catch (e) {
    return {
      ok: false,
      payload: {
        success: false,
        message: e instanceof Error ? e.message : 'request failed',
      },
    };
  }
};

const normalizeSocketedGems = (raw: unknown): Array<{ slot: number; itemDefId: string }> => {
  const src = Array.isArray(raw) ? raw : [];
  return src
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const row = x as Record<string, unknown>;
      const slot = Number(row.slot);
      const itemDefId = String(row.itemDefId || row.item_def_id || '');
      if (!Number.isInteger(slot) || slot < 0 || !itemDefId) return null;
      return { slot, itemDefId };
    })
    .filter((x): x is { slot: number; itemDefId: string } => !!x)
    .sort((a, b) => a.slot - b.slot);
};

const findInventoryItem = async (
  token: string,
  predicate: (it: any) => boolean,
): Promise<any | null> => {
  const locations: Array<'bag' | 'warehouse' | 'equipped'> = ['bag', 'warehouse', 'equipped'];
  for (const location of locations) {
    const list = await getJson(`${base}/api/inventory/items?location=${location}&page=1&pageSize=200`, token);
    const items = Array.isArray(list?.data?.items) ? list.data.items : [];
    const found = items.find(predicate);
    if (found) return found;
  }
  return null;
};

const equipIfNeeded = async (token: string, itemId: number): Promise<void> => {
  const eqBefore = await findInventoryItem(token, (x) => Number(x?.id) === itemId);
  if (!eqBefore) throw new Error('equip target not found');
  if (String(eqBefore.location) === 'equipped') return;
  const equipRes = await postJson(`${base}/api/inventory/equip`, { itemId }, token);
  must(Boolean(equipRes?.success), `equip failed: ${String(equipRes?.message ?? '')}`);
};

const getCharAttrs = async (characterId: number): Promise<{ wugong: number; fagong: number; maxQixue: number }> => {
  const result = await query(
    `SELECT wugong, fagong, max_qixue FROM characters WHERE id = $1 LIMIT 1`,
    [characterId],
  );
  if (!result.rows[0]) return { wugong: 0, fagong: 0, maxQixue: 0 };
  const row = result.rows[0] as Record<string, unknown>;
  return {
    wugong: pickNum(row.wugong),
    fagong: pickNum(row.fagong),
    maxQixue: pickNum(row.max_qixue),
  };
};

const main = async () => {
  const username = `e2e${String(Date.now()).slice(-13)}`;
  const password = 'pass123456';

  const reg = await postJson(`${base}/api/auth/register`, { username, password });
  if (!reg?.success) throw new Error(`register failed: ${reg?.message}`);
  const token = String(reg.data.token);
  const userId = Number(reg.data.user.id);

  const nickname = `测试${Math.floor(Math.random() * 9000 + 1000)}`;
  const ch = await postJson(`${base}/api/character/create`, { nickname, gender: 'male' }, token);
  if (!ch?.success) throw new Error(`create character failed: ${ch?.message}`);
  const characterId = Number(ch.data.character.id);

  const eq = await createItem(userId, characterId, 'equip-weapon-003', 1, { location: 'bag' });
  if (!eq.success || !eq.itemIds?.[0]) throw new Error(`create equip failed: ${eq.message}`);
  const equipId = Number(eq.itemIds[0]);

  const mats = await createItem(userId, characterId, 'enhance-001', 80, { location: 'bag' });
  if (!mats.success) throw new Error(`create material failed: ${mats.message}`);
  const refineMats = await createItem(userId, characterId, 'enhance-002', 80, { location: 'bag' });
  if (!refineMats.success) throw new Error(`create refine material failed: ${refineMats.message}`);
  const gemAtkDefId = 'gem-atk-wg-1';
  const gemDefDefId = 'gem-def-wf-1';
  const gemHpDefId = 'gem-sur-hp-1';
  const gemAtk = await createItem(userId, characterId, gemAtkDefId, 1, { location: 'bag' });
  if (!gemAtk.success || !gemAtk.itemIds?.[0]) throw new Error(`create ${gemAtkDefId} failed: ${gemAtk.message}`);
  const gemDef = await createItem(userId, characterId, gemDefDefId, 1, { location: 'bag' });
  if (!gemDef.success || !gemDef.itemIds?.[0]) throw new Error(`create ${gemDefDefId} failed: ${gemDef.message}`);
  const gemHp = await createItem(userId, characterId, gemHpDefId, 1, { location: 'bag' });
  if (!gemHp.success || !gemHp.itemIds?.[0]) throw new Error(`create ${gemHpDefId} failed: ${gemHp.message}`);

  const gemAtkItemId = Number(gemAtk.itemIds?.[0]);
  const gemDefItemId = Number(gemDef.itemIds?.[0]);
  const gemHpItemId = Number(gemHp.itemIds?.[0]);

  const equipBefore = await findInBag(token, (x) => Number(x?.id) === equipId);
  const matBefore = await findInBag(token, (x) => String(x?.item_def_id) === 'enhance-001');
  const refineMatBefore = await findInBag(token, (x) => String(x?.item_def_id) === 'enhance-002');
  const before = {
    lv: Number(equipBefore?.strengthen_level ?? 0),
    refineLv: Number(equipBefore?.refine_level ?? 0),
    wugong: Number(equipBefore?.def?.base_attrs?.wugong ?? 0),
    matQty: Number(matBefore?.qty ?? 0),
    refineMatQty: Number(refineMatBefore?.qty ?? 0),
    socketed: normalizeSocketedGems(equipBefore?.socketed_gems),
  };

  const logs: Array<{ i: number; success: boolean; msg: string; lv: number }> = [];
  let seenSuccess = false;
  let seenFail = false;
  for (let i = 1; i <= 30 && !(seenSuccess && seenFail); i++) {
    const r = await postJson(`${base}/api/inventory/enhance`, { itemId: equipId }, token);
    logs.push({
      i,
      success: Boolean(r?.success),
      msg: String(r?.message ?? ''),
      lv: Number(r?.data?.strengthenLevel ?? 0),
    });
    if (r?.success) seenSuccess = true;
    else seenFail = true;
  }

  await query(
    `UPDATE item_instance
       SET strengthen_level = 0,
           location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  await query(
    `UPDATE item_instance
       SET strengthen_level = 8,
           location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  const refineLogs: E2eLog[] = [];
  let refineSeenSuccess = false;
  let refineSeenFail = false;
  for (let i = 1; i <= 60 && !(refineSeenSuccess && refineSeenFail); i += 1) {
    const r = await postJson(`${base}/api/inventory/refine`, { itemId: equipId }, token);
    const row: E2eLog = {
      i,
      success: Boolean(r?.success),
      msg: String(r?.message ?? ''),
      refineLevel: pickNum(r?.data?.refineLevel),
      targetLevel: pickNum(r?.data?.targetLevel),
      successRate: pickNum(r?.data?.successRate),
      roll: pickNum(r?.data?.roll),
    };
    refineLogs.push(row);
    if (r?.success) refineSeenSuccess = true;
    else refineSeenFail = true;
  }

  await query(
    `UPDATE item_instance
       SET refine_level = 5,
           location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  const refineDowngradeLogs: E2eLog[] = [];
  for (let i = 1; i <= 60; i += 1) {
    const r = await postJson(`${base}/api/inventory/refine`, { itemId: equipId }, token);
    const row: E2eLog = {
      i,
      success: Boolean(r?.success),
      msg: String(r?.message ?? ''),
      refineLevel: pickNum(r?.data?.refineLevel),
      targetLevel: pickNum(r?.data?.targetLevel),
    };
    refineDowngradeLogs.push(row);
    if (!r?.success) {
      const lv = pickNum(r?.data?.refineLevel, -1);
      must(lv === 4 || lv === 5, `unexpected refine fail level: ${lv}`);
      break;
    }
  }

  const socketRes = await postJson(
    `${base}/api/inventory/socket`,
    { itemId: equipId, gemItemId: gemAtkItemId, slot: 0 },
    token,
  );
  must(Boolean(socketRes?.success), `socket gem failed: ${String(socketRes?.message ?? '')}`);
  must(pickNum(socketRes?.data?.slot, -1) === 0, 'socket slot mismatch');
  must(String(socketRes?.data?.gem?.itemDefId || '') === gemAtkDefId, 'socket gem itemDefId mismatch');

  const replaceSocketRes = await postJson(
    `${base}/api/inventory/socket`,
    { itemId: equipId, gemItemId: gemDefItemId, slot: 0 },
    token,
  );
  must(Boolean(replaceSocketRes?.success), `replace socket failed: ${String(replaceSocketRes?.message ?? '')}`);
  must(Boolean(replaceSocketRes?.data?.replacedGem), 'expected replacedGem on replace socket');

  const invalidSocket = await postInventory(
    '/api/inventory/socket',
    { itemId: equipId, gemItemId: gemHpItemId, slot: 99 },
    token,
  );

  const removeSocketGone = await postInventory('/api/inventory/socket/remove', { itemId: equipId, slot: 0 }, token);
  must(
    !removeSocketGone.ok || !Boolean(removeSocketGone.payload?.success),
    'socket/remove endpoint should be unavailable',
  );

  await equipIfNeeded(token, equipId);
  const charBeforeSocket = await getCharAttrs(characterId);
  const equipSocketRes = await postJson(
    `${base}/api/inventory/socket`,
    { itemId: equipId, gemItemId: gemHpItemId },
    token,
  );
  must(Boolean(equipSocketRes?.success), 'socket on equipped item failed');

  const charAfterSocket = await withRetry(async () => {
    const row = await getCharAttrs(characterId);
    if (row.maxQixue < charBeforeSocket.maxQixue + 2) {
      throw new Error('max_qixue not updated yet');
    }
    return row;
  }, 5);

  const equipReplaceRes = await postJson(
    `${base}/api/inventory/socket`,
    { itemId: equipId, gemItemId: gemDefItemId, slot: 0 },
    token,
  );
  must(Boolean(equipReplaceRes?.success), 'replace socket on equipped item failed');
  must(Boolean(equipReplaceRes?.data?.replacedGem), 'expected replacedGem on equipped replace socket');

  const charAfterReplace = await withRetry(async () => {
    const row = await getCharAttrs(characterId);
    if (row.maxQixue > charAfterSocket.maxQixue - 2) {
      throw new Error('max_qixue not updated after replace yet');
    }
    return row;
  }, 5);

  await query(
    `UPDATE item_instance
       SET location = 'bag',
           equipped_slot = NULL,
           location_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  const equipAfter = await findInBag(token, (x) => Number(x?.id) === equipId);
  const matAfter = await findInBag(token, (x) => String(x?.item_def_id) === 'enhance-001');
  const refineMatAfter = await findInBag(token, (x) => String(x?.item_def_id) === 'enhance-002');
  const gemDefAfter = await findInBag(token, (x) => String(x?.item_def_id) === gemDefDefId);
  const gemHpAfter = await findInBag(token, (x) => String(x?.item_def_id) === gemHpDefId);
  const after = {
    lv: Number(equipAfter?.strengthen_level ?? 0),
    refineLv: Number(equipAfter?.refine_level ?? 0),
    wugong: Number(equipAfter?.def?.base_attrs?.wugong ?? 0),
    matQty: Number(matAfter?.qty ?? 0),
    refineMatQty: Number(refineMatAfter?.qty ?? 0),
    socketed: normalizeSocketedGems(equipAfter?.socketed_gems),
    gemDefenseQty: Number(gemDefAfter?.qty ?? 0),
    gemSurvivalQty: Number(gemHpAfter?.qty ?? 0),
  };

  await query(
    `UPDATE item_instance
       SET strengthen_level = 0,
           location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  await query(
    `DELETE FROM item_instance
     WHERE owner_character_id = $1 AND item_def_id = 'enhance-001' AND location IN ('bag','warehouse')`,
    [characterId],
  );
  await query(
    `DELETE FROM item_instance
     WHERE owner_character_id = $1 AND item_def_id = 'enhance-002' AND location IN ('bag','warehouse')`,
    [characterId],
  );
  const enhanceNoMatRetry = await postInventory('/api/inventory/enhance', { itemId: equipId }, token);

  await query(
    `UPDATE item_instance
       SET refine_level = 0,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  await query(
    `DELETE FROM item_instance
     WHERE owner_character_id = $1 AND item_def_id = 'enhance-002' AND location IN ('bag','warehouse')`,
    [characterId],
  );
  const refineNoMat = await postInventory('/api/inventory/refine', { itemId: equipId }, token);

  await query(
    `UPDATE characters
       SET silver = 0,
           spirit_stones = 0,
           updated_at = NOW()
     WHERE id = $1`,
    [characterId],
  );
  await createItem(userId, characterId, 'enhance-001', 1, { location: 'bag' });
  const enhanceNoMoney = await postInventory('/api/inventory/enhance', { itemId: equipId }, token);

  await query(
    `UPDATE item_instance
       SET location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = true,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );
  const socketLocked = await postInventory('/api/inventory/socket', { itemId: equipId, gemItemId: gemAtkItemId }, token);

  await query(
    `UPDATE item_instance
       SET location = 'auction',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );
  const socketTrade = await postInventory('/api/inventory/socket', { itemId: equipId, gemItemId: gemAtkItemId }, token);

  await query(
    `UPDATE item_instance
       SET location = 'bag',
           location_slot = NULL,
           equipped_slot = NULL,
           locked = false,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  await query(
    `UPDATE item_instance
       SET refine_level = 10,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );
  const refineCap = await postInventory('/api/inventory/refine', { itemId: equipId }, token);

  await query(
    `UPDATE item_instance
       SET socketed_gems = '[]'::jsonb,
           updated_at = NOW()
     WHERE id = $1 AND owner_character_id = $2`,
    [equipId, characterId],
  );

  await query(
    "UPDATE item_instance SET location = 'auction', location_slot = NULL, equipped_slot = NULL, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2",
    [equipId, characterId],
  );
  const trade = await postJson(`${base}/api/inventory/enhance`, { itemId: equipId }, token);

  await query(
    "UPDATE item_instance SET location = 'bag', location_slot = NULL, equipped_slot = NULL, locked = true, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2",
    [equipId, characterId],
  );
  const locked = await postJson(`${base}/api/inventory/enhance`, { itemId: equipId }, token);

  await query(
    "UPDATE item_instance SET locked = false, location = 'bag', location_slot = NULL, strengthen_level = 15, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2",
    [equipId, characterId],
  );
  const cap = await postJson(`${base}/api/inventory/enhance`, { itemId: equipId }, token);

  const summary = {
    username,
    userId,
    characterId,
    equipId,
    before,
    logs,
    refineLogs,
    refineDowngradeLogs,
    socket: {
      first: { success: Boolean(socketRes?.success), msg: String(socketRes?.message ?? '') },
      replace: {
        success: Boolean(replaceSocketRes?.success),
        msg: String(replaceSocketRes?.message ?? ''),
        replacedGem: replaceSocketRes?.data?.replacedGem ?? null,
      },
      invalidSlot: {
        ok: invalidSocket.ok,
        success: Boolean(invalidSocket.payload?.success),
        msg: String(invalidSocket.payload?.message ?? ''),
      },
      removeEndpoint: {
        ok: removeSocketGone.ok,
        success: Boolean(removeSocketGone.payload?.success),
        msg: String(removeSocketGone.payload?.message ?? ''),
      },
      onEquipped: {
        socketSuccess: Boolean(equipSocketRes?.success),
        replaceSuccess: Boolean(equipReplaceRes?.success),
      },
    },
    equippedAttrRefresh: {
      before: charBeforeSocket,
      afterSocket: charAfterSocket,
      afterReplace: charAfterReplace,
      maxQixueRaised: charAfterSocket.maxQixue - charBeforeSocket.maxQixue,
      maxQixueReplaced: charAfterSocket.maxQixue - charAfterReplace.maxQixue,
    },
    negativeCases: {
      enhanceNoMaterial: {
        ok: enhanceNoMatRetry.ok,
        success: Boolean(enhanceNoMatRetry.payload?.success),
        msg: String(enhanceNoMatRetry.payload?.message ?? ''),
      },
      refineNoMaterial: {
        ok: refineNoMat.ok,
        success: Boolean(refineNoMat.payload?.success),
        msg: String(refineNoMat.payload?.message ?? ''),
      },
      enhanceNoMoney: {
        ok: enhanceNoMoney.ok,
        success: Boolean(enhanceNoMoney.payload?.success),
        msg: String(enhanceNoMoney.payload?.message ?? ''),
      },
      socketLocked: {
        ok: socketLocked.ok,
        success: Boolean(socketLocked.payload?.success),
        msg: String(socketLocked.payload?.message ?? ''),
      },
      socketTrade: {
        ok: socketTrade.ok,
        success: Boolean(socketTrade.payload?.success),
        msg: String(socketTrade.payload?.message ?? ''),
      },
      refineCap: {
        ok: refineCap.ok,
        success: Boolean(refineCap.payload?.success),
        msg: String(refineCap.payload?.message ?? ''),
      },
    },
    after,
    trade: { success: trade?.success, msg: trade?.message },
    locked: { success: locked?.success, msg: locked?.message },
    cap: { success: cap?.success, msg: cap?.message },
  };

  // 强制关键断言，便于脚本作为 e2e gate 使用
  must(Boolean(summary.logs.some((x) => x.success)), 'enhance should have at least one success in random attempts');
  must(Boolean(summary.logs.some((x) => !x.success)), 'enhance should have at least one fail in random attempts');
  must(Boolean(summary.refineLogs.some((x) => x.success)), 'refine should have at least one success in random attempts');
  must(Boolean(summary.refineLogs.some((x) => !x.success)), 'refine should have at least one fail in random attempts');
  must(summary.equippedAttrRefresh.maxQixueRaised >= 2, 'equipped socket should raise max_qixue by gem effect');
  must(summary.equippedAttrRefresh.maxQixueReplaced >= 2, 'replace socket should refresh max_qixue by gem effect');
  must(!summary.negativeCases.enhanceNoMaterial.success, 'enhanceNoMaterial should fail');
  must(!summary.negativeCases.refineNoMaterial.success, 'refineNoMaterial should fail');
  must(!summary.negativeCases.enhanceNoMoney.success, 'enhanceNoMoney should fail');
  must(!summary.negativeCases.socketLocked.success, 'socketLocked should fail');
  must(!summary.negativeCases.socketTrade.success, 'socketTrade should fail');
  must(!summary.negativeCases.refineCap.success, 'refineCap should fail');

  console.log(
    JSON.stringify(summary),
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
