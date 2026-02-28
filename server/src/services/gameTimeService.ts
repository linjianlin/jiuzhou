import { query } from '../config/database.js';

export type GameTimeSnapshot = {
  era_name: string;
  base_year: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  shichen: string;
  weather: string;
  scale: number;
  server_now_ms: number;
  game_elapsed_ms: number;
};

type GameTimeStateRow = {
  id: number;
  era_name: string;
  base_year: number;
  game_elapsed_ms: number;
  weather: string;
  scale: number;
  last_real_ms: number;
};

type GameTimeState = {
  era_name: string;
  base_year: number;
  game_elapsed_ms: number;
  weather: string;
  scale: number;
  last_real_ms: number;
};

const DEFAULT_ERA_NAME = '末法纪元';
const DEFAULT_BASE_YEAR = 1000;
const DEFAULT_WEATHER = '晴';
const DEFAULT_START_HOUR = 7;
const WEATHER_BUCKET_MS = 1 * 60 * 60 * 1000;

const getEnvScale = (): number => {
  const raw = process.env.GAME_TIME_SCALE;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 60;
  if (n <= 0) return 60;
  return Math.floor(n);
};

const calcShichen = (hour: number): string => {
  const h = Math.floor(hour);
  if (h === 23 || (h >= 0 && h < 1)) return '子时';
  if (h >= 1 && h < 3) return '丑时';
  if (h >= 3 && h < 5) return '寅时';
  if (h >= 5 && h < 7) return '卯时';
  if (h >= 7 && h < 9) return '辰时';
  if (h >= 9 && h < 11) return '巳时';
  if (h >= 11 && h < 13) return '午时';
  if (h >= 13 && h < 15) return '未时';
  if (h >= 15 && h < 17) return '申时';
  if (h >= 17 && h < 19) return '酉时';
  if (h >= 19 && h < 21) return '戌时';
  return '亥时';
};

const buildSnapshotFromElapsed = (
  state: GameTimeState,
  serverNowMs: number,
  gameElapsedMs: number
): GameTimeSnapshot => {
  const totalSec = Math.floor(gameElapsedMs / 1000);
  const second = ((totalSec % 60) + 60) % 60;
  const totalMin = Math.floor(totalSec / 60);
  const minute = ((totalMin % 60) + 60) % 60;
  const totalHour = Math.floor(totalMin / 60);
  const hour = ((totalHour % 24) + 24) % 24;
  const totalDay = Math.floor(totalHour / 24);
  const day = ((totalDay % 30) + 30) % 30 + 1;
  const totalMonth = Math.floor(totalDay / 30);
  const month = ((totalMonth % 12) + 12) % 12 + 1;
  const yearAdd = Math.floor(totalMonth / 12);
  const year = state.base_year + yearAdd;

  return {
    era_name: state.era_name,
    base_year: state.base_year,
    year,
    month,
    day,
    hour,
    minute,
    second,
    shichen: calcShichen(hour),
    weather: state.weather,
    scale: state.scale,
    server_now_ms: serverNowMs,
    game_elapsed_ms: gameElapsedMs,
  };
};

const getCalendarFromElapsed = (baseYear: number, gameElapsedMs: number): { year: number; month: number; day: number; hour: number } => {
  const totalSec = Math.floor(gameElapsedMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHour = Math.floor(totalMin / 60);
  const hour = ((totalHour % 24) + 24) % 24;
  const totalDay = Math.floor(totalHour / 24);
  const day = ((totalDay % 30) + 30) % 30 + 1;
  const totalMonth = Math.floor(totalDay / 30);
  const month = ((totalMonth % 12) + 12) % 12 + 1;
  const yearAdd = Math.floor(totalMonth / 12);
  const year = baseYear + yearAdd;
  return { year, month, day, hour };
};

const hashU32 = (seed: number): number => {
  let h = (seed >>> 0) ^ 0x811c9dc5;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = h ^ (h >>> 16);
  return h >>> 0;
};

const pickWeighted = (r01: number, items: Array<{ w: number; v: string }>): string => {
  const list = items.filter((x) => Number.isFinite(x.w) && x.w > 0);
  const sum = list.reduce((s, x) => s + x.w, 0);
  if (sum <= 0) return DEFAULT_WEATHER;
  let acc = 0;
  const r = Math.max(0, Math.min(0.999999999, r01)) * sum;
  for (const x of list) {
    acc += x.w;
    if (r <= acc) return x.v;
  }
  return list[list.length - 1]?.v ?? DEFAULT_WEATHER;
};

const getWeatherWeightsByMonth = (month: number): Array<{ w: number; v: string }> => {
  const m = Math.floor(month);
  const inWinter = m === 12 || m === 1 || m === 2;
  const inSpring = m === 3 || m === 4 || m === 5;
  const inSummer = m === 6 || m === 7 || m === 8;
  if (inWinter) {
    return [
      { v: '雪', w: 0.35 },
      { v: '阴', w: 0.25 },
      { v: '晴', w: 0.25 },
      { v: '雾', w: 0.1 },
      { v: '雨', w: 0.05 },
    ];
  }
  if (inSpring) {
    return [
      { v: '晴', w: 0.3 },
      { v: '雨', w: 0.3 },
      { v: '阴', w: 0.25 },
      { v: '雾', w: 0.1 },
      { v: '雷', w: 0.05 },
    ];
  }
  if (inSummer) {
    return [
      { v: '晴', w: 0.35 },
      { v: '雨', w: 0.25 },
      { v: '雷', w: 0.2 },
      { v: '阴', w: 0.15 },
      { v: '雾', w: 0.05 },
    ];
  }
  return [
    { v: '晴', w: 0.35 },
    { v: '阴', w: 0.3 },
    { v: '雨', w: 0.2 },
    { v: '雾', w: 0.1 },
    { v: '雷', w: 0.05 },
  ];
};

let lastWeatherBucket: number | null = null;

const updateWeatherIfNeeded = (state: GameTimeState, gameElapsedMs: number): void => {
  const bucket = Math.floor(gameElapsedMs / WEATHER_BUCKET_MS);
  if (bucket === lastWeatherBucket) return;
  lastWeatherBucket = bucket;

  const cal = getCalendarFromElapsed(state.base_year, gameElapsedMs);
  const seed = hashU32(((bucket & 0xffffffff) ^ ((cal.year & 0xffff) << 16) ^ (cal.month & 0xff) ^ ((cal.day & 0x3f) << 8)) >>> 0);
  const r01 = seed / 0x1_0000_0000;
  const next = pickWeighted(r01, getWeatherWeightsByMonth(cal.month));
  state.weather = next;
};

let runtimeState: GameTimeState | null = null;
let timer: NodeJS.Timeout | null = null;
let saving = false;

const loadOrCreateState = async (): Promise<GameTimeState> => {
  const res = await query(`SELECT * FROM game_time WHERE id = 1 LIMIT 1`);
  const row = (res.rows?.[0] ?? null) as Partial<GameTimeStateRow> | null;

  const nowMs = Date.now();
  const scale = getEnvScale();

  if (!row) {
    const startElapsedMs = DEFAULT_START_HOUR * 60 * 60 * 1000;
    const state: GameTimeState = {
      era_name: DEFAULT_ERA_NAME,
      base_year: DEFAULT_BASE_YEAR,
      game_elapsed_ms: startElapsedMs,
      weather: DEFAULT_WEATHER,
      scale,
      last_real_ms: nowMs,
    };
    await query(
      `
        INSERT INTO game_time (id, era_name, base_year, game_elapsed_ms, weather, scale, last_real_ms)
        VALUES (1, $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          era_name = EXCLUDED.era_name,
          base_year = EXCLUDED.base_year,
          game_elapsed_ms = EXCLUDED.game_elapsed_ms,
          weather = EXCLUDED.weather,
          scale = EXCLUDED.scale,
          last_real_ms = EXCLUDED.last_real_ms,
          updated_at = NOW()
      `,
      [state.era_name, state.base_year, state.game_elapsed_ms, state.weather, state.scale, state.last_real_ms]
    );
    return state;
  }

  const lastRealMs = Number(row.last_real_ms ?? nowMs);
  const prevScale = Number(row.scale ?? scale);
  const baseElapsedMs = Number(row.game_elapsed_ms ?? 0);
  const deltaRealMs = Math.max(0, nowMs - lastRealMs);
  const curElapsedMs = baseElapsedMs + deltaRealMs * prevScale;

  const state: GameTimeState = {
    era_name: typeof row.era_name === 'string' && row.era_name.length > 0 ? row.era_name : DEFAULT_ERA_NAME,
    base_year: Number.isFinite(Number(row.base_year)) ? Number(row.base_year) : DEFAULT_BASE_YEAR,
    game_elapsed_ms: curElapsedMs,
    weather: typeof row.weather === 'string' && row.weather.length > 0 ? row.weather : DEFAULT_WEATHER,
    scale: prevScale > 0 ? Math.floor(prevScale) : scale,
    last_real_ms: nowMs,
  };

  await query(
    `
      UPDATE game_time
      SET
        era_name = $1,
        base_year = $2,
        game_elapsed_ms = $3,
        weather = $4,
        scale = $5,
        last_real_ms = $6,
        updated_at = NOW()
      WHERE id = 1
    `,
    [state.era_name, state.base_year, state.game_elapsed_ms, state.weather, state.scale, state.last_real_ms]
  );

  return state;
};

const tickAndPersist = async (): Promise<void> => {
  const state = runtimeState;
  if (!state) return;
  if (saving) return;

  const nowMs = Date.now();
  const delta = nowMs - state.last_real_ms;
  const deltaRealMs = delta > 0 && delta < 60_000 ? delta : 1000;

  state.game_elapsed_ms += deltaRealMs * state.scale;
  state.last_real_ms = nowMs;
  updateWeatherIfNeeded(state, state.game_elapsed_ms);

  saving = true;
  try {
    await query(
      `
        UPDATE game_time
        SET
          game_elapsed_ms = $1,
          weather = $2,
          scale = $3,
          last_real_ms = $4,
          updated_at = NOW()
        WHERE id = 1
      `,
      [state.game_elapsed_ms, state.weather, state.scale, state.last_real_ms]
    );
  } finally {
    saving = false;
  }
};

export const initGameTimeService = async (): Promise<void> => {
  if (runtimeState) return;
  runtimeState = await loadOrCreateState();
  updateWeatherIfNeeded(runtimeState, runtimeState.game_elapsed_ms);
  if (!timer) timer = setInterval(() => void tickAndPersist(), 1000);
};

export const stopGameTimeService = async (): Promise<void> => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 最后一次保存状态
  if (runtimeState && !saving) {
    await tickAndPersist();
  }
};

export const getGameTimeSnapshot = (): GameTimeSnapshot | null => {
  const state = runtimeState;
  if (!state) return null;
  const serverNowMs = Date.now();
  const elapsedMs = state.game_elapsed_ms + Math.max(0, serverNowMs - state.last_real_ms) * state.scale;
  return buildSnapshotFromElapsed(state, serverNowMs, elapsedMs);
};
