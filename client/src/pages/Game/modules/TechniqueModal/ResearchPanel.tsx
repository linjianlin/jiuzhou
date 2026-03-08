/**
 * 洞府研修面板
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承载洞府研修统计、生成中提示、草稿详情、失败结果与抄写入口。
 * 2. 做什么：复用 `researchShared` 的单一状态映射，避免组件内散落 `pending/generated_draft/failed` 判断。
 * 3. 不做什么：不直接发请求、不持有 socket 订阅，也不管理主界面红点状态。
 *
 * 输入/输出：
 * - 输入：研修状态数据、加载态、按钮提交态，以及兑换/生成/刷新/抄写回调。
 * - 输出：纯渲染组件，通过回调把用户操作交给上层协调。
 *
 * 数据流/状态流：
 * TechniqueModal -> ResearchPanel -> 用户点击按钮 -> 回调返回 TechniqueModal -> API / socket。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 时不能再允许重复点击“开始领悟”，否则会误导玩家可以并发生成。
 * 2. 草稿详情中的技能可能没有完整描述，卡片需要优雅回退到摘要文本，避免出现空白块。
 */
import { Button, Tag, Tooltip } from 'antd';
import type { TechniqueResearchStatusData } from './researchShared';
import { resolveTechniqueResearchPanelView } from './researchShared';
import {
  mapResearchPreviewSkillToDetail,
  renderSkillCardDetails,
  renderSkillTooltip,
} from './skillDetailShared';

type ResearchPanelProps = {
  status: TechniqueResearchStatusData | null;
  loading: boolean;
  refreshing: boolean;
  exchangeSubmitting: boolean;
  generateSubmitting: boolean;
  publishSubmitting: boolean;
  onExchangeBooks: () => void;
  onGenerateDraft: () => void;
  onRefresh: () => void;
  onCopyResearchBook: (generationId: string, suggestedName: string) => void;
};

const QUALITY_CLASS_COLOR: Record<'黄' | '玄' | '地' | '天', string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

const QUALITY_TEXT: Record<'黄' | '玄' | '地' | '天', string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const ResearchPanel: React.FC<ResearchPanelProps> = ({
  status,
  loading,
  refreshing,
  exchangeSubmitting,
  generateSubmitting,
  publishSubmitting,
  onExchangeBooks,
  onGenerateDraft,
  onRefresh,
  onCopyResearchBook,
}) => {
  const minCost = status
    ? Math.min(...Object.values(status.generationCostByQuality || { 黄: 500, 玄: 500, 地: 500, 天: 500 }))
    : 500;
  const panelView = resolveTechniqueResearchPanelView(status);
  const weeklyRemaining = status?.weeklyRemaining ?? 0;
  const pointsBalance = status?.pointsBalance ?? 0;
  const canTryGenerate =
    status !== null &&
    panelView.kind !== 'pending' &&
    weeklyRemaining > 0 &&
    pointsBalance >= minCost;

  return (
    <div className="tech-pane">
      <div className="tech-pane-scroll">
        <div className="tech-subtitle">洞府研修</div>
        <div className="tech-research-stats">
          <div className="tech-research-stat"><span>研修点</span><strong>{status?.pointsBalance ?? '--'}</strong></div>
          <div className="tech-research-stat"><span>本周已用</span><strong>{status?.weeklyUsed ?? '--'}</strong></div>
          <div className="tech-research-stat"><span>本周剩余</span><strong>{status?.weeklyRemaining ?? '--'}</strong></div>
        </div>

        {/* <div className="tech-research-costs">
          {(Object.entries(status?.generationCostByQuality || { 黄: 500, 玄: 500, 地: 500, 天: 500 }) as Array<[string, number]>).map(
            ([quality, cost]) => (
              <Tag key={quality} color="default">
                {quality}品: {cost}点
              </Tag>
            ),
          )}
        </div> */}

        <div className="tech-research-actions">
          <Button loading={exchangeSubmitting} onClick={onExchangeBooks}>
            一键兑换功法书
          </Button>
          <Button
            type="primary"
            loading={generateSubmitting}
            disabled={!canTryGenerate}
            onClick={onGenerateDraft}
          >
            开始领悟
          </Button>
          <Button loading={refreshing} onClick={onRefresh}>
            刷新
          </Button>
        </div>

        <div className="tech-research-tips">
          <div>1. 先将多余功法书兑换为研修点，再进行领悟。</div>
          <div>2. 推演完成后，主界面“功法”入口会出现红点提醒。</div>
          <div>3. 结果进入研修页后即视为已查看，抄写前仍可在此处查看草稿详情。</div>
        </div>

        <div className="tech-subtitle">当前研修结果</div>
        {loading ? <div className="tech-empty">加载中...</div> : null}
        {!loading && panelView.kind === 'empty' ? (
          <div className="tech-empty">暂无研修结果，点击“开始领悟”开始推演</div>
        ) : null}
        {!loading && panelView.kind === 'pending' ? (
          <div className="tech-research-status-card is-pending">
            <div className="tech-research-status-title">AI 正在洞府中推演功法</div>
            <div className="tech-research-status-desc">
              当前任务已进入独立推演流程，生成完成后会通过主界面“功法”入口红点提醒你回来查看。
            </div>
            <div className="tech-research-status-meta">
              <Tag color="processing">推演中</Tag>
              <Tag color="default">任务 #{panelView.job.generationId}</Tag>
            </div>
          </div>
        ) : null}
        {!loading && panelView.kind === 'failed' ? (
          <div className="tech-research-status-card is-failed">
            <div className="tech-research-status-title">本次洞府研修未能成法</div>
            <div className="tech-research-status-desc">{panelView.errorMessage}</div>
            <div className="tech-research-status-foot">本次研修点已自动退还，可在条件满足时重新开始领悟。</div>
          </div>
        ) : null}
        {!loading && panelView.kind === 'draft' ? (
          <div className="tech-research-draft">
            <div className="tech-research-draft-name">{panelView.preview.aiSuggestedName}</div>
            <div className="tech-research-draft-meta">
              <Tag color={QUALITY_CLASS_COLOR[panelView.preview.quality]}>{QUALITY_TEXT[panelView.preview.quality]}</Tag>
              <Tag color="default">{panelView.preview.type}</Tag>
              <Tag color="default">最高{panelView.preview.maxLayer}层</Tag>
            </div>
            <div className="tech-research-draft-desc">{panelView.preview.description || '暂无描述'}</div>
            {panelView.preview.longDesc ? (
              <div className="tech-research-draft-long-desc">{panelView.preview.longDesc}</div>
            ) : null}
            <div className="tech-research-draft-expire">
              草稿过期时间：{panelView.job.draftExpireAt ? new Date(panelView.job.draftExpireAt).toLocaleString() : '--'}
            </div>
            <div className="tech-research-skill-list">
              {panelView.preview.skills.map((skill) => {
                const previewSkill = mapResearchPreviewSkillToDetail(skill);
                return (
                  <Tooltip key={skill.id} title={renderSkillTooltip(previewSkill)} placement="top">
                    <div className="tech-research-skill-card">
                      {renderSkillCardDetails(previewSkill)}
                    </div>
                  </Tooltip>
                );
              })}
            </div>
            <div className="tech-research-actions">
              <Button
                className="tech-research-copy-button"
                type="primary"
                loading={publishSubmitting}
                onClick={() => onCopyResearchBook(panelView.job.generationId, panelView.preview.aiSuggestedName)}
              >
                抄写功法书
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ResearchPanel;
