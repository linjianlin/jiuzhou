/**
 * 印记效果文案格式化（技能/套装共用）
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：把 mark 相关字段（支持 camelCase 与 snake_case）解析为统一结构，并输出稳定中文文案。
 * - 不做什么：不负责触发时机文案（如“命中/受击”），不负责战斗日志拼接顺序。
 *
 * 输入/输出：
 * - 输入：任意包含 mark 字段的对象（技能 effect 或套装 effect.params）。
 * - 输出：可直接展示的文案字符串；当字段不足以识别 mark 行为时返回 null。
 *
 * 数据流/状态流：
 * - skillEffectFormatter.ts / bagShared.ts 传入原始效果对象
 * - 本模块执行字段兼容与语义归一化
 * - 返回文案到各调用方，确保“同一机制 = 同一文本规则”
 *
 * 关键边界条件与坑点：
 * 1) operation 仅识别 apply/consume，未知值直接返回 null，避免误导文案。
 * 2) consumeMode 只识别 fixed，其余默认按 all 处理，保障旧数据可读。
 */

type MarkOperation = "apply" | "consume";
type MarkConsumeMode = "all" | "fixed";
type MarkResultType = "damage" | "shield_self" | "heal_self";

type ParsedMarkEffect = {
  markId: string;
  operation: MarkOperation;
  maxStacks: number;
  duration: number;
  applyStacks: number;
  consumeMode: MarkConsumeMode;
  consumeStacks: number;
  perStackRate: number;
  resultType: MarkResultType;
};

const VOID_EROSION_MARK_ID = "void_erosion";

const MARK_NAME_MAP: Record<string, string> = {
  [VOID_EROSION_MARK_ID]: "虚蚀印记",
};

const RESULT_TYPE_TEXT: Record<MarkResultType, string> = {
  damage: "伤害",
  shield_self: "自身护盾",
  heal_self: "自身治疗",
};

const toText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const readField = (raw: Record<string, unknown>, camel: string, snake: string): unknown => {
  if (raw[camel] !== undefined) return raw[camel];
  return raw[snake];
};

const normalizePositiveInt = (value: unknown, fallback: number): number => {
  const n = Math.floor(toNumber(value) ?? fallback);
  return n > 0 ? n : fallback;
};

const normalizeOperation = (value: unknown): MarkOperation | null => {
  const op = toText(value).toLowerCase();
  if (op === "apply" || op === "consume") return op;
  return null;
};

const normalizeConsumeMode = (value: unknown): MarkConsumeMode => {
  const mode = toText(value).toLowerCase();
  return mode === "fixed" ? "fixed" : "all";
};

const normalizeResultType = (value: unknown): MarkResultType => {
  const type = toText(value).toLowerCase();
  if (type === "shield_self") return "shield_self";
  if (type === "heal_self") return "heal_self";
  return "damage";
};

const formatPercent = (value: number): string => {
  const percent = value * 100;
  if (Number.isInteger(percent)) return `${percent}`;
  return `${Number(percent.toFixed(2))}`;
};

const parseMarkEffect = (raw: Record<string, unknown>): ParsedMarkEffect | null => {
  const operation = normalizeOperation(readField(raw, "operation", "operation"));
  if (!operation) return null;

  const markId = toText(readField(raw, "markId", "mark_id")) || VOID_EROSION_MARK_ID;
  const maxStacks = normalizePositiveInt(readField(raw, "maxStacks", "max_stacks"), 5);
  const duration = normalizePositiveInt(readField(raw, "duration", "duration_round"), 2);
  const applyStacks = normalizePositiveInt(
    readField(raw, "applyStacks", "apply_stacks") ?? readField(raw, "stacks", "stacks"),
    1,
  );
  const consumeMode = normalizeConsumeMode(readField(raw, "consumeMode", "consume_mode"));
  const consumeStacks = normalizePositiveInt(readField(raw, "consumeStacks", "consume_stacks"), 1);
  const perStackRate = Math.max(0, toNumber(readField(raw, "perStackRate", "per_stack_rate")) ?? 0);
  const resultType = normalizeResultType(readField(raw, "resultType", "result_type"));

  return {
    markId,
    operation,
    maxStacks,
    duration,
    applyStacks,
    consumeMode,
    consumeStacks,
    perStackRate,
    resultType,
  };
};

export const formatMarkEffectText = (raw: Record<string, unknown>): string | null => {
  const parsed = parseMarkEffect(raw);
  if (!parsed) return null;

  const markName = MARK_NAME_MAP[parsed.markId] || parsed.markId;
  if (parsed.operation === "apply") {
    return `施加${markName}（每次+${parsed.applyStacks}层，上限${parsed.maxStacks}层，持续${parsed.duration}回合）`;
  }

  const consumeModeText =
    parsed.consumeMode === "fixed" ? `固定${parsed.consumeStacks}层` : "全部层数";
  const perStackText = parsed.perStackRate > 0 ? `每层系数${formatPercent(parsed.perStackRate)}%` : "每层系数0%";
  return `消耗${markName}（${consumeModeText}，${perStackText}），转化为${RESULT_TYPE_TEXT[parsed.resultType]}`;
};
