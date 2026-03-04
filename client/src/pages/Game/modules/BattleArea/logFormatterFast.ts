import type {
  BattleActionTargetDto,
  BattleLogEntryDto,
  BattleRewardsDto,
  BattleStateDto,
} from '../../../../services/api';
import { buildBattleLootLine } from '../../shared/battleLoot';
import { translateBuffName, translateBuffNames, translateControlName } from './logNameMap';

const toSafeInt = (value: number | string | null | undefined): number => {
  return Math.max(0, Math.floor(Number(value) || 0));
};

const normalizeName = (value: string | number | null | undefined, fallback: string): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const buildRoundLabel = (round: number): string => {
  const value = Math.max(1, toSafeInt(round));
  return `第${value}回合`;
};

const buildCharacterNameMap = (state: BattleStateDto): Map<number, string> => {
  const map = new Map<number, string>();
  for (const unit of state.teams?.attacker?.units ?? []) {
    if (unit.type !== 'player') continue;
    const matched = /^player-(\d+)$/.exec(String(unit.id || ''));
    const characterId = matched ? Number(matched[1]) : NaN;
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    const name = String(unit.name || '').trim();
    if (!name) continue;
    map.set(characterId, name);
  }
  return map;
};

const buildHitDetail = (target: BattleActionTargetDto): string[] => {
  if (target.hits.length === 0) return [];

  const hitLines = target.hits.map((hit) => {
    const parts: string[] = [];
    if (hit.isMiss) parts.push('未命中');
    if (hit.isParry) parts.push('被招架');
    if (hit.isCrit) parts.push('暴击');
    if (hit.isElementBonus) parts.push('五行克制');

    const shieldAbsorbed = toSafeInt(hit.shieldAbsorbed);
    if (shieldAbsorbed > 0) parts.push(`护盾吸收${shieldAbsorbed}`);

    const damage = toSafeInt(hit.damage);
    if (damage > 0) parts.push(`伤害-${damage}`);

    if (parts.length === 0) {
      parts.push('未造成伤害');
    }

    if (target.hits.length <= 1) {
      return parts.join('，');
    }

    const hitIndex = Math.max(1, toSafeInt(hit.index));
    return `第${hitIndex}击:${parts.join('，')}`;
  });

  return [hitLines.join('；')];
};

const buildTargetSummary = (target: BattleActionTargetDto): string => {
  const name = normalizeName(target.targetName, '未知目标');
  const parts: string[] = [];

  if (target.controlResisted) {
    parts.push('抵抗控制');
  }

  if (target.controlApplied) {
    const controlName = normalizeName(translateControlName(target.controlApplied), String(target.controlApplied));
    parts.push(`受控:${controlName}`);
  }

  parts.push(...buildHitDetail(target));

  if (target.hits.length === 0) {
    if (target.isMiss) parts.push('未命中');
    if (target.isParry) parts.push('被招架');
    if (target.isCrit) parts.push('暴击');
    if (target.isElementBonus) parts.push('五行克制');

    const shieldAbsorbed = toSafeInt(target.shieldAbsorbed);
    if (shieldAbsorbed > 0) parts.push(`护盾吸收${shieldAbsorbed}`);

    const damage = toSafeInt(target.damage);
    if (damage > 0) parts.push(`伤害-${damage}`);
  }

  const heal = toSafeInt(target.heal);
  if (heal > 0) {
    parts.push(`治疗+${heal}`);
  }

  const resources = (target.resources ?? [])
    .map((row) => ({
      type: String(row.type || '').trim(),
      amount: toSafeInt(row.amount),
    }))
    .filter((row) => row.amount > 0 && (row.type === 'qixue' || row.type === 'lingqi'));
  for (const resource of resources) {
    if (resource.type === 'qixue') {
      parts.push(`气血+${resource.amount}`);
      continue;
    }
    parts.push(`灵气+${resource.amount}`);
  }

  const buffsApplied = translateBuffNames(target.buffsApplied);
  if (buffsApplied.length > 0) {
    parts.push(`获得状态:${buffsApplied.join('、')}`);
  }

  const buffsRemoved = translateBuffNames(target.buffsRemoved);
  if (buffsRemoved.length > 0) {
    parts.push(`移除状态:${buffsRemoved.join('、')}`);
  }

  if (parts.length === 0) {
    return name;
  }

  return `${name}（${parts.join('，')}）`;
};

const buildActionLogLine = (log: Extract<BattleLogEntryDto, { type: 'action' }>): string => {
  const roundText = buildRoundLabel(log.round);
  const actorName = normalizeName(log.actorName, '未知单位');
  const skillName = normalizeName(log.skillName, '未知技能');
  const verb = String(log.skillId || '').startsWith('proc-') ? '触发' : '施展';
  const actionHead = `${roundText} ${actorName} ${verb}【${skillName}】`;

  const targets = (log.targets ?? []).map((target) => buildTargetSummary(target)).filter(Boolean);
  if (targets.length === 0) return actionHead;
  return `${actionHead}，目标：${targets.join('；')}`;
};

const buildDotLogLine = (log: Extract<BattleLogEntryDto, { type: 'dot' }>): string => {
  const roundText = buildRoundLabel(log.round);
  const unitName = normalizeName(log.unitName, '未知单位');
  const buffName = normalizeName(translateBuffName(log.buffName), String(log.buffName));
  const damage = toSafeInt(log.damage);
  return `${roundText} ${unitName} 受【${buffName}】影响，伤害-${damage}`;
};

const buildHotLogLine = (log: Extract<BattleLogEntryDto, { type: 'hot' }>): string => {
  const roundText = buildRoundLabel(log.round);
  const unitName = normalizeName(log.unitName, '未知单位');
  const buffName = normalizeName(translateBuffName(log.buffName), String(log.buffName));
  const heal = toSafeInt(log.heal);
  return `${roundText} ${unitName} 受【${buffName}】影响，治疗+${heal}`;
};

const buildBuffExpireLogLine = (log: Extract<BattleLogEntryDto, { type: 'buff_expire' }>): string => {
  const roundText = buildRoundLabel(log.round);
  const unitName = normalizeName(log.unitName, '未知单位');
  const buffName = normalizeName(translateBuffName(log.buffName), String(log.buffName));
  return `${roundText} ${unitName} 的【${buffName}】结束`;
};

const buildDeathLogLine = (log: Extract<BattleLogEntryDto, { type: 'death' }>): string => {
  const roundText = buildRoundLabel(log.round);
  const unitName = normalizeName(log.unitName, '未知单位');
  const killerName = String(log.killerName ?? '').trim();
  if (killerName) {
    return `${roundText} ${unitName} 被 ${killerName} 击倒`;
  }
  return `${roundText} ${unitName} 倒下`;
};

const formatResultText = (result: BattleStateDto['result']): string => {
  if (result === 'attacker_win') return '得胜';
  if (result === 'defender_win') return '落败';
  if (result === 'draw') return '平局';
  return '落幕';
};

export const FAST_BATTLE_LOG_SYSTEM_LINES = {
  cancelled: '【斗法落幕】战斗取消',
  startFailed: '【斗法落幕】战斗发起失败',
  abandoned: '【斗法落幕】已遁离战场',
  escaped: '【斗法落幕】已撤退',
} as const;

export const formatBattleLogLineFast = (log: BattleLogEntryDto): string | null => {
  if (!log) return null;
  if (log.type === 'action') return buildActionLogLine(log);
  if (log.type === 'round_start' || log.type === 'round_end') return null;
  if (log.type === 'dot') return buildDotLogLine(log);
  if (log.type === 'hot') return buildHotLogLine(log);
  if (log.type === 'buff_expire') return buildBuffExpireLogLine(log);
  if (log.type === 'death') return buildDeathLogLine(log);
  return null;
};

export const buildBattleStartLineFast = (state: BattleStateDto): string => {
  const attackerNames = (state.teams?.attacker?.units ?? [])
    .map((unit) => normalizeName(unit.name, ''))
    .filter(Boolean);
  const defenderNames = (state.teams?.defender?.units ?? [])
    .map((unit) => normalizeName(unit.name, ''))
    .filter(Boolean);
  const playerCount = (state.teams?.attacker?.units ?? []).filter((unit) => unit.type === 'player').length;
  const teamHint = playerCount > 1 ? `（同门${playerCount}人）` : '';

  return `【斗法开启·极速日志】我方：${attackerNames.join('、') || '未知'}；敌方：${defenderNames.join('、') || '未知'}${teamHint}`;
};

export const buildBattleEndLineFast = (state: BattleStateDto): string => {
  const attackerAlive = (state.teams?.attacker?.units ?? [])
    .filter((unit) => unit.isAlive)
    .map((unit) => normalizeName(unit.name, ''))
    .filter(Boolean)
    .join('、');
  const defenderAlive = (state.teams?.defender?.units ?? [])
    .filter((unit) => unit.isAlive)
    .map((unit) => normalizeName(unit.name, ''))
    .filter(Boolean)
    .join('、');
  const roundText = buildRoundLabel(state.roundCount);

  return `【斗法落幕】${formatResultText(state.result)}，历经${roundText}；我方尚存：${attackerAlive || '无'}；敌方尚存：${defenderAlive || '无'}`;
};

export const buildRewardSummaryLinesFast = (
  state: BattleStateDto | null | undefined,
  rewards: BattleRewardsDto | null | undefined,
): string[] => {
  if (!state || state.phase !== 'finished') return [];
  if (!rewards) return ['【斗法所得】暂无收获'];

  const totalExp = toSafeInt(rewards.totalExp ?? rewards.exp);
  const totalSilver = toSafeInt(rewards.totalSilver ?? rewards.silver);
  const participantCount = Math.max(1, toSafeInt(rewards.participantCount));

  const perPlayerRewards = rewards.perPlayerRewards ?? [];
  if (perPlayerRewards.length === 0) {
    return [`【斗法所得】修为+${totalExp} 银两+${totalSilver}`];
  }

  const playerNameMap = buildCharacterNameMap(state);

  // 单人战斗：只显示个人奖励，不显示总计
  if (participantCount === 1 && perPlayerRewards.length === 1) {
    const reward = perPlayerRewards[0];
    const playerName = playerNameMap.get(reward.characterId) ?? `角色${reward.characterId}`;
    const exp = toSafeInt(reward.exp);
    const silver = toSafeInt(reward.silver);
    return [`【斗法所得】${playerName} 修为+${exp} 银两+${silver}`];
  }

  // 多人战斗：显示总计 + 各人分配
  const totalLine = `【斗法所得】队伍共得 修为+${totalExp} 银两+${totalSilver}（${participantCount}人）`;
  const perLines = perPlayerRewards.map((reward) => {
    const playerName = playerNameMap.get(reward.characterId) ?? `角色${reward.characterId}`;
    const exp = toSafeInt(reward.exp);
    const silver = toSafeInt(reward.silver);
    return `【斗法所得】${playerName} 分得 修为+${exp} 银两+${silver}`;
  });

  return [totalLine, ...perLines];
};

export const buildDropLinesFast = (
  state: BattleStateDto | null | undefined,
  rewards: BattleRewardsDto | null | undefined,
): string[] => {
  const items = rewards?.items ?? [];
  if (!state || items.length === 0) return [];

  const playerNameMap = buildCharacterNameMap(state);

  // 按玩家分组物品
  const itemsByReceiver = new Map<number, Array<{ itemName: string; quantity: number }>>();

  for (const item of items) {
    const receiverId = item.receiverId;
    const itemName = normalizeName(item.name || item.itemDefId, '未知物品');
    const quantity = Math.max(1, toSafeInt(item.quantity));

    if (!itemsByReceiver.has(receiverId)) {
      itemsByReceiver.set(receiverId, []);
    }
    itemsByReceiver.get(receiverId)!.push({ itemName, quantity });
  }

  // 为每个玩家生成一行日志
  return Array.from(itemsByReceiver.entries()).map(([receiverId, receiverItems]) => {
    const receiverName = playerNameMap.get(receiverId) ?? `角色${receiverId}`;
    return buildBattleLootLine(receiverName, receiverItems);
  });
};
