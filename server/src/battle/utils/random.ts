/**
 * 九州修仙录 - 战斗随机数生成器
 * 使用确定性随机数，防止客户端作弊
 */

import type { BattleState } from '../types.js';

/**
 * 基于种子的伪随机数生成器（Mulberry32）
 * 确保相同种子产生相同序列，便于验证和回放
 */
function seededRandom(seed: number): number {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

/**
 * 从战斗状态获取下一个随机数 [0, 1)
 */
export function getNextRandom(state: BattleState): number {
  const value = seededRandom(state.randomSeed + state.randomIndex);
  state.randomIndex++;
  return value;
}

/**
 * 获取 [0, max) 范围的随机整数
 */
export function getRandomInt(state: BattleState, max: number): number {
  return Math.floor(getNextRandom(state) * max);
}

/**
 * 万分比概率判定
 * @param state 战斗状态
 * @param rate 万分比概率 (0-10000)
 * @returns 是否成功
 */
export function rollChance(state: BattleState, rate: number): boolean {
  const roll = getNextRandom(state) * 10000;
  return roll < rate;
}

/**
 * 生成战斗随机种子
 */
export function generateBattleSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

/**
 * 打乱数组（Fisher-Yates）
 */
export function shuffle<T>(state: BattleState, array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = getRandomInt(state, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
