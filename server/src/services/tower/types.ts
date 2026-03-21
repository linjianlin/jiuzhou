/**
 * 千层塔领域类型定义。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义塔进度、楼层预览、排行与战斗运行时的共享类型，避免路由、服务、结算各维护一套平行接口。
 * 2. 做什么：把“算法生成的楼层结果”和“持久化进度状态”明确拆开，便于后续扩展而不污染 BattleSession 类型。
 * 3. 不做什么：不承载 UI 状态，也不替代 battle engine 自身的战斗数据结构。
 *
 * 输入/输出：
 * - 输入：塔服务、塔算法、塔路由在运行中拼装的数据。
 * - 输出：服务端内部共享类型，以及直接暴露给前端的 DTO 形状。
 *
 * 数据流/状态流：
 * - 算法生成楼层 -> 服务创建 battle/runtime -> 结算更新进度 -> overview/rank 读取同一组类型。
 *
 * 关键边界条件与坑点：
 * 1. `currentFloor` 与 `lastSettledFloor` 语义不同：前者表示当前 run 正在/准备挑战的层数，后者表示本次 run 最近一次已结算层数。
 * 2. 楼层预览只承载算法生成的挑战信息，不再混入奖励字段，避免 overview、结算、前端展示各自维护一份平行奖励结构。
 */

import type { BattleSessionSnapshot } from '../battleSession/types.js';
import type { MonsterData } from '../../battle/battleFactory.js';

export type TowerFloorKind = 'normal' | 'elite' | 'boss';

export interface TowerProgressRecord {
  characterId: number;
  bestFloor: number;
  nextFloor: number;
  currentRunId: string | null;
  currentFloor: number | null;
  currentBattleId: string | null;
  lastSettledFloor: number;
  updatedAt: string;
  reachedAt: string | null;
}

export interface TowerFloorPreview {
  floor: number;
  kind: TowerFloorKind;
  seed: string;
  realm: string;
  monsterIds: string[];
  monsterNames: string[];
}

export interface ResolvedTowerFloor {
  preview: TowerFloorPreview;
  monsters: MonsterData[];
}

export interface TowerOverviewDto {
  progress: {
    bestFloor: number;
    nextFloor: number;
    currentRunId: string | null;
    currentFloor: number | null;
    lastSettledFloor: number;
  };
  activeSession: BattleSessionSnapshot | null;
  nextFloorPreview: TowerFloorPreview;
}

export interface TowerRankRow {
  rank: number;
  characterId: number;
  name: string;
  realm: string;
  bestFloor: number;
  reachedAt: string | null;
}

export interface TowerBattleRuntimeRecord {
  battleId: string;
  characterId: number;
  userId: number;
  runId: string;
  floor: number;
  monsters: MonsterData[];
  preview: TowerFloorPreview;
}
