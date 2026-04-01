/**
 * 云游奇遇服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供云游奇遇的概览读取、冷却校验、异步生成、选项确认与结局称号发放完整闭环。
 * 2. 做什么：把“1 小时冷却、一幕一选、正式称号接入”收敛为单一业务入口，避免路由与前端各自维护状态机。
 * 3. 不做什么：不直接处理 HTTP 参数，不替代现有正式称号装备接口，也不吞掉 AI/数据库异常。
 *
 * 输入/输出：
 * - 输入：`characterId`，以及选项确认时的 `episodeId`、`optionIndex`。
 * - 输出：统一 service result，包含概览、当前幕次或确认后的故事结果。
 *
 * 数据流/状态流：
 * 前端请求 -> 本服务校验冷却与当前幕次状态 -> 读取角色与故事上下文 -> AI 生成新一幕 -> 落库 episode/story
 * -> 玩家确认选项 -> 结局时创建动态正式称号定义并写入 `character_title`。
 *
 * 关键边界条件与坑点：
 * 1. 每个角色同一时间只能有一幕待选择剧情，且完成后按真实创建时间进入 1 小时冷却；`day_key` 只负责稳定排序与唯一索引，不再承担冷却判断。
 * 2. 动态结局称号虽然进入正式称号体系，但属性加成由服务端固定映射控制，不能让 AI 直接决定数值。
 */
import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { getMapDefinitions } from '../staticConfigLoader.js';
import { grantPermanentTitleTx } from '../achievement/titleOwnership.js';
import { generateWanderAiEpisodeDraft, isWanderAiAvailable, type WanderAiPreviousEpisodeContext } from './ai.js';
import { resolveWanderTargetEpisodeCount } from './episodePlan.js';
import {
  buildDateKey,
  buildWanderCooldownState,
  formatWanderCooldownRemaining,
  resolveWanderGenerationDayKey,
} from './rules.js';
import type {
  WanderChooseResultDto,
  WanderEndingType,
  WanderEpisodeDto,
  WanderGenerateQueueResultDto,
  WanderGenerationJobDto,
  WanderGenerationJobStatus,
  WanderGeneratedTitleDto,
  WanderOverviewDto,
  WanderStoryDto,
  WanderStoryStatus,
} from './types.js';

type ServiceResult<T> = {
  success: boolean;
  message: string;
  data?: T;
};

type CharacterContextRow = {
  id: number;
  nickname: string;
  realm: string | null;
  sub_realm: string | null;
  current_map_id: string | null;
  has_team: boolean;
};

type WanderStoryRow = {
  id: string;
  character_id: number;
  status: string;
  story_theme: string;
  story_premise: string;
  story_summary: string;
  episode_count: number;
  story_seed: number;
  reward_title_id: string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type WanderEpisodeRow = {
  id: string;
  story_id: string;
  character_id: number;
  day_key: Date | string;
  day_index: number;
  episode_title: string;
  opening: string;
  option_texts: string[];
  chosen_option_index: number | null;
  chosen_option_text: string | null;
  episode_summary: string;
  is_ending: boolean;
  ending_type: string;
  reward_title_name: string | null;
  reward_title_desc: string | null;
  created_at: Date | string;
  chosen_at: Date | string | null;
};

type WanderGeneratedTitleRow = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  effects: Record<string, number>;
  is_equipped: boolean;
  obtained_at: Date | string;
};

type WanderGenerationJobRow = {
  id: string;
  character_id: number;
  day_key: Date | string;
  status: string;
  error_message: string | null;
  generated_episode_id: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

const WANDER_MAX_CONTEXT_EPISODES = 5;
const WANDER_SOURCE_TYPE = 'wander_story';

const toIsoString = (value: Date | string | null): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toRequiredIsoString = (value: Date | string): string => {
  const normalized = toIsoString(value);
  if (!normalized) {
    throw new Error('云游奇遇时间字段无效');
  }
  return normalized;
};

const buildStoryId = (): string => `wander-story-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const buildEpisodeId = (): string => `wander-episode-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const buildGeneratedTitleId = (): string => `title-wander-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const buildGenerationId = (): string => `wander-job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const normalizeEndingType = (value: string): WanderEndingType => {
  if (value === 'good' || value === 'neutral' || value === 'tragic' || value === 'bizarre') {
    return value;
  }
  return 'none';
};

const buildRealmText = (realm: string | null, subRealm: string | null): string => {
  const baseRealm = (realm ?? '').trim() || '凡人';
  const baseSubRealm = (subRealm ?? '').trim();
  if (!baseSubRealm || baseRealm === '凡人') return baseRealm;
  return `${baseRealm}·${baseSubRealm}`;
};

const getMapName = (mapId: string | null): string => {
  const normalizedMapId = (mapId ?? '').trim();
  if (!normalizedMapId) return '未知地域';
  const map = getMapDefinitions().find((entry) => entry.id === normalizedMapId);
  return (map?.name ?? '').trim() || normalizedMapId;
};

const resolveGeneratedTitleColor = (endingType: WanderEndingType): string => {
  if (endingType === 'good') return '#faad14';
  if (endingType === 'neutral') return '#4dabf7';
  if (endingType === 'tragic') return '#ff7875';
  if (endingType === 'bizarre') return '#b37feb';
  return '#d9d9d9';
};

const resolveGeneratedTitleEffects = (endingType: WanderEndingType): Record<string, number> => {
  if (endingType === 'good') {
    return { max_qixue: 60, wugong: 5 };
  }
  if (endingType === 'neutral') {
    return { max_lingqi: 60, fagong: 5 };
  }
  if (endingType === 'tragic') {
    return { wufang: 6, fafang: 6 };
  }
  if (endingType === 'bizarre') {
    return { sudu: 4, max_lingqi: 30 };
  }
  return { max_qixue: 30 };
};

const buildEpisodeDto = (row: WanderEpisodeRow): WanderEpisodeDto => {
  return {
    id: row.id,
    dayKey: buildDateKey(new Date(row.day_key)),
    dayIndex: row.day_index,
    title: row.episode_title,
    opening: row.opening,
    options: row.option_texts.map((text, index) => ({
      index,
      text,
    })),
    chosenOptionIndex: row.chosen_option_index,
    chosenOptionText: row.chosen_option_text,
    summary: row.episode_summary,
    isEnding: row.is_ending,
    endingType: normalizeEndingType(row.ending_type),
    rewardTitleName: row.reward_title_name,
    rewardTitleDesc: row.reward_title_desc,
    createdAt: toRequiredIsoString(row.created_at),
    chosenAt: toIsoString(row.chosen_at),
  };
};

const buildStoryDto = (story: WanderStoryRow, episodeRows: WanderEpisodeRow[]): WanderStoryDto => {
  return {
    id: story.id,
    status: (story.status === 'finished' ? 'finished' : 'active') as WanderStoryStatus,
    theme: story.story_theme,
    premise: story.story_premise,
    summary: story.story_summary,
    episodeCount: story.episode_count,
    rewardTitleId: story.reward_title_id,
    finishedAt: toIsoString(story.finished_at),
    createdAt: toRequiredIsoString(story.created_at),
    updatedAt: toRequiredIsoString(story.updated_at),
    episodes: episodeRows
      .slice()
      .sort((a, b) => a.day_index - b.day_index)
      .map(buildEpisodeDto),
  };
};

const normalizeGeneratedTitleRow = (row: WanderGeneratedTitleRow): WanderGeneratedTitleDto => {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    effects: row.effects ?? {},
    isEquipped: row.is_equipped,
    obtainedAt: toRequiredIsoString(row.obtained_at),
  };
};

const buildGenerationJobDto = (row: WanderGenerationJobRow): WanderGenerationJobDto => {
  return {
    generationId: row.id,
    status: (row.status === 'generated' || row.status === 'failed' ? row.status : 'pending') as WanderGenerationJobStatus,
    startedAt: toRequiredIsoString(row.created_at),
    finishedAt: toIsoString(row.finished_at),
    errorMessage: row.error_message,
  };
};

const buildOverview = (params: {
  today: string;
  aiAvailable: boolean;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  isCoolingDown: boolean;
  currentGenerationJob: WanderGenerationJobDto | null;
  activeStory: WanderStoryDto | null;
  currentEpisode: WanderEpisodeDto | null;
  latestFinishedStory: WanderStoryDto | null;
  generatedTitles: WanderGeneratedTitleDto[];
}): WanderOverviewDto => {
  const hasPendingEpisode = params.currentEpisode !== null && params.currentEpisode.chosenOptionIndex === null;
  return {
    today: params.today,
    aiAvailable: params.aiAvailable,
    hasPendingEpisode,
    canGenerate: params.aiAvailable && !hasPendingEpisode && !params.isCoolingDown && params.currentGenerationJob?.status !== 'pending',
    isCoolingDown: params.isCoolingDown,
    cooldownUntil: params.cooldownUntil,
    cooldownRemainingSeconds: params.cooldownRemainingSeconds,
    currentGenerationJob: params.currentGenerationJob,
    activeStory: params.activeStory,
    currentEpisode: params.currentEpisode,
    latestFinishedStory: params.latestFinishedStory,
    generatedTitles: params.generatedTitles,
  };
};

class WanderService {
  private async loadCharacterContext(characterId: number): Promise<CharacterContextRow | null> {
    const result = await query<CharacterContextRow>(
      `
        SELECT c.id, c.nickname, c.realm, c.sub_realm, c.current_map_id,
               EXISTS(SELECT 1 FROM team_members tm WHERE tm.character_id = c.id) AS has_team
        FROM characters c
        WHERE c.id = $1
        LIMIT 1
      `,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  private async loadEpisodeRowByDayKey(characterId: number, dayKey: string): Promise<WanderEpisodeRow | null> {
    const result = await query<WanderEpisodeRow>(
      `
        SELECT id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
               chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
               reward_title_name, reward_title_desc, created_at, chosen_at
        FROM character_wander_story_episode
        WHERE character_id = $1
          AND day_key = $2::date
        LIMIT 1
      `,
      [characterId, dayKey],
    );
    return result.rows[0] ?? null;
  }

  private async loadLatestEpisodeRow(characterId: number): Promise<WanderEpisodeRow | null> {
    const result = await query<WanderEpisodeRow>(
      `
        SELECT id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
               chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
               reward_title_name, reward_title_desc, created_at, chosen_at
        FROM character_wander_story_episode
        WHERE character_id = $1
        ORDER BY day_key DESC, day_index DESC, created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  private async loadActiveStoryRow(characterId: number): Promise<WanderStoryRow | null> {
    const result = await query<WanderStoryRow>(
      `
        SELECT id, character_id, status, story_theme, story_premise, story_summary, episode_count,
               story_seed, reward_title_id, finished_at, created_at, updated_at
        FROM character_wander_story
        WHERE character_id = $1
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  private async loadLatestFinishedStoryRow(characterId: number): Promise<WanderStoryRow | null> {
    const result = await query<WanderStoryRow>(
      `
        SELECT id, character_id, status, story_theme, story_premise, story_summary, episode_count,
               story_seed, reward_title_id, finished_at, created_at, updated_at
        FROM character_wander_story
        WHERE character_id = $1
          AND status = 'finished'
        ORDER BY finished_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  private async loadEpisodeRowsByStoryId(storyId: string): Promise<WanderEpisodeRow[]> {
    const result = await query<WanderEpisodeRow>(
      `
        SELECT id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
               chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
               reward_title_name, reward_title_desc, created_at, chosen_at
        FROM character_wander_story_episode
        WHERE story_id = $1
        ORDER BY day_index ASC
      `,
      [storyId],
    );
    return result.rows;
  }

  private async loadGeneratedTitleRows(characterId: number): Promise<WanderGeneratedTitleDto[]> {
    const result = await query<WanderGeneratedTitleRow>(
      `
        SELECT gtd.id, gtd.name, gtd.description, gtd.color, gtd.effects, ct.is_equipped, ct.obtained_at
        FROM character_title ct
        JOIN generated_title_def gtd ON gtd.id = ct.title_id
        WHERE ct.character_id = $1
          AND gtd.source_type = $2
          AND gtd.enabled = true
          AND (ct.expires_at IS NULL OR ct.expires_at > NOW())
        ORDER BY ct.obtained_at DESC, gtd.created_at DESC
      `,
      [characterId, WANDER_SOURCE_TYPE],
    );
    return result.rows.map(normalizeGeneratedTitleRow);
  }

  private async loadLatestGenerationJobRowByCharacterId(characterId: number): Promise<WanderGenerationJobRow | null> {
    const result = await query<WanderGenerationJobRow>(
      `
        SELECT id, character_id, day_key, status, error_message, generated_episode_id, created_at, finished_at
        FROM character_wander_generation_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    return result.rows[0] ?? null;
  }

  private async loadGenerationJobRowByIdForUpdate(generationId: string, characterId: number): Promise<WanderGenerationJobRow | null> {
    const result = await query<WanderGenerationJobRow>(
      `
        SELECT id, character_id, day_key, status, error_message, generated_episode_id, created_at, finished_at
        FROM character_wander_generation_job
        WHERE id = $1
          AND character_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    return result.rows[0] ?? null;
  }

  private async updateGenerationJobAsGenerated(generationId: string, episodeId: string): Promise<void> {
    await query(
      `
        UPDATE character_wander_generation_job
        SET status = 'generated',
            generated_episode_id = $2,
            error_message = NULL,
            finished_at = NOW()
        WHERE id = $1
      `,
      [generationId, episodeId],
    );
  }

  private async updateGenerationJobAsFailed(generationId: string, errorMessage: string): Promise<void> {
    await query(
      `
        UPDATE character_wander_generation_job
        SET status = 'failed',
            generated_episode_id = NULL,
            error_message = $2,
            finished_at = NOW()
        WHERE id = $1
      `,
      [generationId, errorMessage],
    );
  }

  private async loadRecentEpisodeContext(storyId: string): Promise<WanderAiPreviousEpisodeContext[]> {
    const result = await query<WanderEpisodeRow>(
      `
        SELECT id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
               chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
               reward_title_name, reward_title_desc, created_at, chosen_at
        FROM character_wander_story_episode
        WHERE story_id = $1
          AND chosen_option_index IS NOT NULL
        ORDER BY day_index DESC
        LIMIT $2
      `,
      [storyId, WANDER_MAX_CONTEXT_EPISODES],
    );

    return result.rows
      .slice()
      .reverse()
      .map((row) => ({
        dayIndex: row.day_index,
        title: row.episode_title,
        choice: row.chosen_option_text ?? '',
        summary: row.episode_summary,
      }));
  }

  private async buildStoryDtoOrNull(story: WanderStoryRow | null): Promise<WanderStoryDto | null> {
    if (!story) return null;
    const episodeRows = await this.loadEpisodeRowsByStoryId(story.id);
    return buildStoryDto(story, episodeRows);
  }

  async getOverview(characterId: number): Promise<ServiceResult<WanderOverviewDto>> {
    const today = buildDateKey(new Date());
    const aiAvailable = isWanderAiAvailable();
    const [latestEpisodeRow, activeStoryRow, latestFinishedStoryRow, generatedTitles, latestGenerationJobRow] = await Promise.all([
      this.loadLatestEpisodeRow(characterId),
      this.loadActiveStoryRow(characterId),
      this.loadLatestFinishedStoryRow(characterId),
      this.loadGeneratedTitleRows(characterId),
      this.loadLatestGenerationJobRowByCharacterId(characterId),
    ]);
    const cooldownState = buildWanderCooldownState(latestEpisodeRow ? toRequiredIsoString(latestEpisodeRow.created_at) : null);
    const currentEpisodeRow = latestEpisodeRow
      && (latestEpisodeRow.chosen_option_index === null || cooldownState.isCoolingDown)
      ? latestEpisodeRow
      : null;

    const [activeStory, latestFinishedStory] = await Promise.all([
      this.buildStoryDtoOrNull(activeStoryRow),
      this.buildStoryDtoOrNull(latestFinishedStoryRow),
    ]);

    const currentEpisode = currentEpisodeRow ? buildEpisodeDto(currentEpisodeRow) : null;
    const latestEpisodeCreatedAtMs = latestEpisodeRow ? new Date(latestEpisodeRow.created_at).getTime() : Number.NaN;
    const latestGenerationJobCreatedAtMs = latestGenerationJobRow ? new Date(latestGenerationJobRow.created_at).getTime() : Number.NaN;
    const shouldExposeGenerationJob = currentEpisode === null
      && latestGenerationJobRow !== null
      && (latestGenerationJobRow.status === 'pending' || latestGenerationJobRow.status === 'failed')
      && (!Number.isFinite(latestEpisodeCreatedAtMs) || latestGenerationJobCreatedAtMs >= latestEpisodeCreatedAtMs);
    const currentGenerationJob = shouldExposeGenerationJob && latestGenerationJobRow
      ? buildGenerationJobDto(latestGenerationJobRow)
      : null;

    return {
      success: true,
      message: 'ok',
      data: buildOverview({
        today,
        aiAvailable,
        cooldownUntil: cooldownState.cooldownUntil,
        cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
        isCoolingDown: cooldownState.isCoolingDown,
        currentGenerationJob,
        activeStory,
        currentEpisode,
        latestFinishedStory,
        generatedTitles,
      }),
    };
  }

  private async createEpisodeForDayKey(
    characterId: number,
    dayKey: string,
  ): Promise<ServiceResult<{ story: WanderStoryDto; episode: WanderEpisodeDto }>> {
    if (!isWanderAiAvailable()) {
      return { success: false, message: '未配置 AI 文本模型，无法生成云游奇遇' };
    }
    const existingEpisode = await this.loadEpisodeRowByDayKey(characterId, dayKey);
    if (existingEpisode) {
      if (existingEpisode.chosen_option_index !== null) {
        return { success: false, message: '当前奇遇已完成，请等待下一次冷却结束' };
      }

      const activeStory = await this.loadActiveStoryRow(characterId);
      if (!activeStory) {
        return { success: false, message: '当前奇遇状态异常，请稍后重试' };
      }

      const storyDto = await this.buildStoryDtoOrNull(activeStory);
      if (!storyDto) {
        return { success: false, message: '当前奇遇状态异常，请稍后重试' };
      }

      return {
        success: true,
        message: 'ok',
        data: {
          story: storyDto,
          episode: buildEpisodeDto(existingEpisode),
        },
      };
    }

    const character = await this.loadCharacterContext(characterId);
    if (!character) {
      return { success: false, message: '角色不存在' };
    }

    const activeStory = await this.loadActiveStoryRow(characterId);
    const previousEpisodes = activeStory ? await this.loadRecentEpisodeContext(activeStory.id) : [];
    const nextEpisodeIndex = activeStory ? activeStory.episode_count + 1 : 1;
    const storySeed = activeStory?.story_seed ?? Math.max(1, Math.floor(Date.now() % 2_147_483_647));
    const targetEpisodeCount = resolveWanderTargetEpisodeCount(storySeed);
    const aiDraft = await generateWanderAiEpisodeDraft({
      nickname: character.nickname,
      realm: buildRealmText(character.realm, character.sub_realm),
      mapName: getMapName(character.current_map_id),
      hasTeam: character.has_team,
      activeTheme: activeStory?.story_theme ?? null,
      activePremise: activeStory?.story_premise ?? null,
      storySummary: activeStory?.story_summary ?? null,
      nextEpisodeIndex,
      maxEpisodeIndex: targetEpisodeCount,
      canEndThisEpisode: nextEpisodeIndex >= targetEpisodeCount,
      previousEpisodes,
    });

    if (nextEpisodeIndex < targetEpisodeCount && aiDraft.isEnding) {
      throw new Error('云游奇遇模型未按既定总幕数继续推进剧情');
    }
    if (nextEpisodeIndex >= targetEpisodeCount && !aiDraft.isEnding) {
      throw new Error('云游奇遇模型未按既定总幕数收束剧情');
    }

    const storyId = activeStory?.id ?? buildStoryId();
    const episodeId = buildEpisodeId();

    if (!activeStory) {
      await query(
        `
          INSERT INTO character_wander_story (
            id, character_id, status, story_theme, story_premise, story_summary, episode_count,
            story_seed, reward_title_id, finished_at, created_at, updated_at
          )
          VALUES ($1, $2, 'active', $3, $4, $5, 1, $6, NULL, NULL, NOW(), NOW())
        `,
        [storyId, characterId, aiDraft.storyTheme, aiDraft.storyPremise, aiDraft.summary, storySeed],
      );
    } else {
      await query(
        `
          UPDATE character_wander_story
          SET story_theme = $2,
              story_premise = $3,
              story_summary = $4,
              episode_count = $5,
              updated_at = NOW()
          WHERE id = $1
        `,
        [storyId, aiDraft.storyTheme, aiDraft.storyPremise, aiDraft.summary, nextEpisodeIndex],
      );
    }

    await query(
      `
        INSERT INTO character_wander_story_episode (
          id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
          chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
          reward_title_name, reward_title_desc, created_at, chosen_at
        )
        VALUES (
          $1, $2, $3, $4::date, $5, $6, $7, $8::jsonb,
          NULL, NULL, $9, $10, $11, $12, $13, NOW(), NULL
        )
      `,
      [
        episodeId,
        storyId,
        characterId,
        dayKey,
        nextEpisodeIndex,
        aiDraft.episodeTitle,
        aiDraft.opening,
        JSON.stringify(aiDraft.optionTexts),
        aiDraft.summary,
        aiDraft.isEnding,
        aiDraft.endingType,
        aiDraft.rewardTitleName || null,
        aiDraft.rewardTitleDesc || null,
      ],
    );

    const latestStory = await this.buildStoryDtoOrNull({
      id: storyId,
      character_id: characterId,
      status: 'active',
      story_theme: aiDraft.storyTheme,
      story_premise: aiDraft.storyPremise,
      story_summary: aiDraft.summary,
      episode_count: nextEpisodeIndex,
      story_seed: storySeed,
      reward_title_id: null,
      finished_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const currentStory = latestStory ?? (await this.buildStoryDtoOrNull((await this.loadActiveStoryRow(characterId))));
    if (!currentStory) {
      return { success: false, message: '生成奇遇后读取状态失败' };
    }

    const currentEpisode = currentStory.episodes.find((episode) => episode.id === episodeId);
    if (!currentEpisode) {
      return { success: false, message: '生成奇遇后读取幕次失败' };
    }

    return {
      success: true,
      message: 'ok',
      data: {
        story: currentStory,
        episode: currentEpisode,
      },
    };
  }

  async createGenerationJob(characterId: number): Promise<ServiceResult<WanderGenerateQueueResultDto>> {
    if (!isWanderAiAvailable()) {
      return { success: false, message: '未配置 AI 文本模型，无法生成云游奇遇' };
    }

    const [latestGenerationJob, character, latestEpisode] = await Promise.all([
      this.loadLatestGenerationJobRowByCharacterId(characterId),
      this.loadCharacterContext(characterId),
      this.loadLatestEpisodeRow(characterId),
    ]);

    if (!character) {
      return { success: false, message: '角色不存在' };
    }
    if (latestEpisode && latestEpisode.chosen_option_index === null) {
      return {
        success: false,
        message: '当前奇遇已生成，等待抉择',
      };
    }
    if (latestGenerationJob?.status === 'pending') {
      return {
        success: true,
        message: '当前云游正在生成中',
        data: {
          job: buildGenerationJobDto(latestGenerationJob),
        },
      };
    }
    const cooldownState = buildWanderCooldownState(latestEpisode ? toRequiredIsoString(latestEpisode.created_at) : null);
    if (cooldownState.isCoolingDown) {
      return {
        success: false,
        message: `云游冷却中，还需等待${formatWanderCooldownRemaining(cooldownState.cooldownRemainingSeconds)}`,
      };
    }

    const generationId = buildGenerationId();
    const generationDayKey = resolveWanderGenerationDayKey(
      latestEpisode ? buildDateKey(new Date(latestEpisode.day_key)) : null,
      new Date(),
    );
    await query(
      `
        INSERT INTO character_wander_generation_job (
          id, character_id, day_key, status, error_message, generated_episode_id, created_at, finished_at
        )
        VALUES ($1, $2, $3::date, 'pending', NULL, NULL, NOW(), NULL)
      `,
      [generationId, characterId, generationDayKey],
    );

    return {
      success: true,
      message: '当前云游已进入推演',
      data: {
        job: {
          generationId,
          status: 'pending',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          errorMessage: null,
        },
      },
    };
  }

  async markGenerationJobFailed(characterId: number, generationId: string, errorMessage: string): Promise<void> {
    const job = await this.loadGenerationJobRowByIdForUpdate(generationId, characterId);
    if (!job || job.status !== 'pending') {
      return;
    }
    await this.updateGenerationJobAsFailed(generationId, errorMessage);
  }

  async processPendingGenerationJob(
    characterId: number,
    generationId: string,
  ): Promise<ServiceResult<{ status: WanderGenerationJobStatus; episodeId: string | null; errorMessage: string | null }>> {
    const job = await this.loadGenerationJobRowByIdForUpdate(generationId, characterId);
    if (!job) {
      return { success: false, message: '云游生成任务不存在' };
    }
    if (job.status !== 'pending') {
      return {
        success: true,
        message: 'ok',
        data: {
          status: job.status === 'generated' ? 'generated' : 'failed',
          episodeId: job.generated_episode_id,
          errorMessage: job.error_message,
        },
      };
    }

    const dayKey = buildDateKey(new Date(job.day_key));
    const existingEpisode = await this.loadEpisodeRowByDayKey(characterId, dayKey);
    if (existingEpisode) {
      await this.updateGenerationJobAsGenerated(generationId, existingEpisode.id);
      return {
        success: true,
        message: 'ok',
        data: {
          status: 'generated',
          episodeId: existingEpisode.id,
          errorMessage: null,
        },
      };
    }

    try {
      const generationResult = await this.createEpisodeForDayKey(characterId, dayKey);
      if (!generationResult.success || !generationResult.data) {
        const reason = generationResult.message || '云游奇遇生成失败';
        await this.updateGenerationJobAsFailed(generationId, reason);
        return {
          success: true,
          message: 'ok',
          data: {
            status: 'failed',
            episodeId: null,
            errorMessage: reason,
          },
        };
      }

      await this.updateGenerationJobAsGenerated(generationId, generationResult.data.episode.id);
      return {
        success: true,
        message: 'ok',
        data: {
          status: 'generated',
          episodeId: generationResult.data.episode.id,
          errorMessage: null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '云游奇遇生成失败';
      await this.updateGenerationJobAsFailed(generationId, reason);
      return {
        success: true,
        message: 'ok',
        data: {
          status: 'failed',
          episodeId: null,
          errorMessage: reason,
        },
      };
    }
  }

  @Transactional
  async chooseEpisode(
    characterId: number,
    episodeId: string,
    optionIndex: number,
  ): Promise<ServiceResult<WanderChooseResultDto>> {
    const normalizedOptionIndex = Math.floor(optionIndex);
    if (!Number.isFinite(normalizedOptionIndex) || normalizedOptionIndex < 0 || normalizedOptionIndex > 2) {
      return { success: false, message: '选项参数错误' };
    }

    const episodeResult = await query<WanderEpisodeRow>(
      `
        SELECT id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts,
               chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type,
               reward_title_name, reward_title_desc, created_at, chosen_at
        FROM character_wander_story_episode
        WHERE id = $1
          AND character_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [episodeId, characterId],
    );

    const episode = episodeResult.rows[0] ?? null;
    if (!episode) {
      return { success: false, message: '奇遇幕次不存在' };
    }
    if (episode.chosen_option_index !== null) {
      return { success: false, message: '本幕已作出选择' };
    }
    if (!episode.option_texts[normalizedOptionIndex]) {
      return { success: false, message: '所选选项不存在' };
    }

    const chosenOptionText = episode.option_texts[normalizedOptionIndex];

    await query(
      `
        UPDATE character_wander_story_episode
        SET chosen_option_index = $2,
            chosen_option_text = $3,
            chosen_at = NOW()
        WHERE id = $1
      `,
      [episode.id, normalizedOptionIndex, chosenOptionText],
    );

    let awardedTitle: WanderGeneratedTitleDto | null = null;
    let rewardTitleId: string | null = null;

    if (episode.is_ending) {
      const endingType = normalizeEndingType(episode.ending_type);
      const rewardTitleName = (episode.reward_title_name ?? '').trim();
      const rewardTitleDesc = (episode.reward_title_desc ?? '').trim();
      if (!rewardTitleName || !rewardTitleDesc) {
        return { success: false, message: '结局称号数据缺失' };
      }
      const titleId = buildGeneratedTitleId();
      rewardTitleId = titleId;
      const effects = resolveGeneratedTitleEffects(endingType);

      await query(
        `
          INSERT INTO generated_title_def (
            id, name, description, color, icon, effects, source_type, source_id, enabled, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6, $7, true, NOW(), NOW())
        `,
        [
          titleId,
          rewardTitleName,
          rewardTitleDesc,
          resolveGeneratedTitleColor(endingType),
          JSON.stringify(effects),
          WANDER_SOURCE_TYPE,
          episode.story_id,
        ],
      );

      await grantPermanentTitleTx(characterId, titleId);

      awardedTitle = {
        id: titleId,
        name: rewardTitleName,
        description: rewardTitleDesc,
        color: resolveGeneratedTitleColor(endingType),
        effects,
        isEquipped: false,
        obtainedAt: new Date().toISOString(),
      };
    }

    const nextStoryStatus: WanderStoryStatus = episode.is_ending ? 'finished' : 'active';

    await query(
      `
        UPDATE character_wander_story
        SET status = $2::varchar(16),
            story_summary = $3,
            reward_title_id = $4,
            finished_at = CASE WHEN $2::varchar(16) = 'finished' THEN NOW() ELSE finished_at END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [episode.story_id, nextStoryStatus, episode.episode_summary, rewardTitleId],
    );

    const storyResult = await query<WanderStoryRow>(
      `
        SELECT id, character_id, status, story_theme, story_premise, story_summary, episode_count,
               story_seed, reward_title_id, finished_at, created_at, updated_at
        FROM character_wander_story
        WHERE id = $1
        LIMIT 1
      `,
      [episode.story_id],
    );

    const storyRow = storyResult.rows[0] ?? null;
    if (!storyRow) {
      return { success: false, message: '奇遇故事不存在' };
    }

    const story = await this.buildStoryDtoOrNull(storyRow);
    if (!story) {
      return { success: false, message: '奇遇故事读取失败' };
    }

    return {
      success: true,
      message: 'ok',
      data: {
        story,
        awardedTitle,
      },
    };
  }
}

export const wanderService = new WanderService();
