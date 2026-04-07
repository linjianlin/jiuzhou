/**
 * 功法技能详情查询 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：根据功法 ID 统一查询功法详情，并提取可展示的技能信息，供详情面板与 tooltip 复用。
 * 2. 做什么：集中管理 loading / error / skills 三种状态，避免多个入口重复写异步与竞态处理。
 * 3. 不做什么：不决定 UI 是否展示技能区，也不缓存跨页面结果。
 *
 * 输入/输出：
 * - 输入：`techniqueId` 当前要查询的功法 ID；`enabled` 是否允许发起查询。
 * - 输出：`skills` 技能详情数组、`loading` 加载态、`error` 错误文案。
 *
 * 数据流/状态流：
 * learnableTechniqueId -> getTechniqueDetail -> SkillDefDto[] -> Tooltip / Bag Detail。
 *
 * 关键边界条件与坑点：
 * 1. `techniqueId` 为空时必须立刻清空状态，避免前一个 tooltip 或详情面板的数据残留。
 * 2. 快速切换物品会触发并发请求，必须通过取消标记屏蔽过期响应，避免技能卡片闪回。
 */
import { useEffect, useState } from 'react';
import { getUnifiedApiErrorMessage } from '../../../services/api';
import { getTechniqueDetail } from '../../../services/api/technique';
import type { TechniqueSkillDetailLike } from '../modules/TechniqueModal/skillDetailShared';
import { mapTechniqueApiSkillToDetail } from './techniqueBookPreview';

type TechniqueSkillDetailsState = {
  skills: TechniqueSkillDetailLike[];
  loading: boolean;
  error: string | null;
};

type UseTechniqueSkillDetailsOptions = {
  techniqueId: string | null;
  enabled: boolean;
};

export const useTechniqueSkillDetails = ({
  techniqueId,
  enabled,
}: UseTechniqueSkillDetailsOptions): TechniqueSkillDetailsState => {
  const [skills, setSkills] = useState<TechniqueSkillDetailLike[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !techniqueId) {
      setSkills([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getTechniqueDetail(techniqueId)
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !response.data) {
          throw new Error(response.message || '加载功法详情失败');
        }
        setSkills(response.data.skills.map(mapTechniqueApiSkillToDetail));
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setSkills([]);
        setLoading(false);
        setError(getUnifiedApiErrorMessage(error, '加载功法技能失败'));
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, techniqueId]);

  return {
    skills,
    loading,
    error,
  };
};
