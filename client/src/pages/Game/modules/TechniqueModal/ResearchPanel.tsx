/**
 * 洞府研修面板
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承载洞府研修统计、生成中提示、草稿详情、失败结果、放弃与抄写入口。
 * 2. 做什么：复用 `researchShared` 的单一状态映射与冷却格式化，避免组件内散落 `pending/generated_draft/failed/cooldown` 判断。
 * 3. 不做什么：不直接发请求、不持有 socket 订阅，也不管理主界面红点状态。
 *
 * 输入/输出：
 * - 输入：研修状态数据、加载态、按钮提交态，以及生成/刷新/放弃/抄写回调。
 * - 输出：纯渲染组件，通过回调把用户操作交给上层协调。
 *
 * 数据流/状态流：
 * TechniqueModal -> ResearchPanel -> 用户点击按钮 -> 回调返回 TechniqueModal -> API / socket。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 时不能再允许重复点击“开始领悟”，否则会误导玩家可以并发生成。
 * 2. 冷却展示必须仅消费共享纯函数，避免这里和按钮禁用条件各算一套剩余时间。
 */
import { Button, Input, Switch, Tag } from 'antd';
import { getItemQualityLabel, getItemQualityTagClassName } from '../../shared/itemQuality';
import type {
  TechniqueResearchStatusData,
  TechniqueResearchSubmitState,
} from './researchShared';
import {
  hasTechniqueResearchCooldownBypassToken,
  resolveTechniqueResearchCurrentFragmentCost,
  resolveTechniqueResearchCooldownDisplay,
  resolveTechniqueResearchPanelView,
} from './researchShared';
import {
  mapResearchPreviewSkillToDetail,
  renderSkillCardDetails,
} from './skillDetailShared';
import {
  TECHNIQUE_RESEARCH_BURNING_WORD_LABEL,
  buildTechniqueResearchBurningWordTagText,
} from './researchPromptShared';

type ResearchPanelProps = {
  status: TechniqueResearchStatusData | null;
  loading: boolean;
  refreshing: boolean;
  generateSubmitting: boolean;
  discardSubmitting: boolean;
  publishSubmitting: boolean;
  cooldownBypassEnabled: boolean;
  burningWordPromptInput: string;
  submitState: TechniqueResearchSubmitState;
  onGenerateDraft: () => void;
  onBurningWordPromptChange: (nextValue: string) => void;
  onBurningWordPromptCompositionStart: () => void;
  onBurningWordPromptCompositionEnd: (nextValue: string) => void;
  onBurningWordPromptBlur: (nextValue: string) => void;
  onCooldownBypassEnabledChange: (nextEnabled: boolean) => void;
  onRefresh: () => void;
  onDiscardDraft: (generationId: string) => void;
  onCopyResearchBook: (generationId: string, suggestedName: string) => void;
};

const renderTechniqueResearchBurningWordTag = (
  burningWordPrompt: string | null | undefined,
): React.ReactNode => {
  if (!burningWordPrompt) return null;
  return <Tag color="geekblue">{buildTechniqueResearchBurningWordTagText(burningWordPrompt)}</Tag>;
};

const ResearchPanel: React.FC<ResearchPanelProps> = ({
  status,
  loading,
  refreshing,
  generateSubmitting,
  discardSubmitting,
  publishSubmitting,
  cooldownBypassEnabled,
  burningWordPromptInput,
  submitState,
  onGenerateDraft,
  onBurningWordPromptChange,
  onBurningWordPromptCompositionStart,
  onBurningWordPromptCompositionEnd,
  onBurningWordPromptBlur,
  onCooldownBypassEnabledChange,
  onRefresh,
  onDiscardDraft,
  onCopyResearchBook,
}) => {
  const panelView = resolveTechniqueResearchPanelView(status);
  const cooldownDisplay = resolveTechniqueResearchCooldownDisplay(status, cooldownBypassEnabled);
  const currentFragmentCost = resolveTechniqueResearchCurrentFragmentCost(status, cooldownBypassEnabled);
  const burningWordPromptInputDisabled = !status?.unlocked
    || panelView.kind === 'pending'
    || panelView.kind === 'draft'
    || generateSubmitting;
  const hasCooldownBypassCapability = Boolean(status?.unlocked)
    && Boolean(status?.cooldownBypassTokenBypassesCooldown)
    && (status?.cooldownHours ?? 0) > 0;

  return (
    <div className="tech-pane">
      <div className="tech-pane-scroll">
        <div className="tech-subtitle">洞府研修</div>
        <div className="tech-research-stats">
          <div className="tech-research-stat"><span>功法残页</span><strong>{status?.fragmentBalance ?? '--'}</strong></div>
          <div className="tech-research-stat"><span>单次消耗</span><strong>{status ? `${currentFragmentCost}页` : '--'}</strong></div>
          <div className="tech-research-stat">
            <div className="tech-research-stat-head">
              <span>当前状态</span>
              {hasCooldownBypassCapability ? (
                <div className="tech-research-stat-toggle">
                  <span className="tech-research-stat-toggle-label">顿悟符</span>
                  <Switch
                    checked={cooldownBypassEnabled}
                    onChange={onCooldownBypassEnabledChange}
                    disabled={!hasTechniqueResearchCooldownBypassToken(status)}
                    checkedChildren="开"
                    unCheckedChildren="关"
                  />
                </div>
              ) : null}
            </div>
            <strong>{cooldownDisplay.statusText}</strong>
          </div>
        </div>

        <div className="tech-research-actions">
          {panelView.kind === 'pending' ? (
            <Button className="tech-research-refresh-button" loading={refreshing} onClick={onRefresh}>
              刷新状态
            </Button>
          ) : (
            <div className="tech-research-action-row">
              <Input
                className="tech-research-burning-word-input"
                value={burningWordPromptInput}
                onChange={(event) => onBurningWordPromptChange(event.target.value)}
                onCompositionStart={onBurningWordPromptCompositionStart}
                onCompositionEnd={(event) => onBurningWordPromptCompositionEnd(event.currentTarget.value)}
                onBlur={(event) => onBurningWordPromptBlur(event.currentTarget.value)}
                placeholder="留空随机"
                disabled={burningWordPromptInputDisabled}
                prefix={<span className="tech-research-burning-word-prefix">{TECHNIQUE_RESEARCH_BURNING_WORD_LABEL}</span>}
              />
              <Button
                className="tech-research-generate-button"
                type="primary"
                loading={generateSubmitting}
                disabled={!submitState.canSubmit}
                onClick={onGenerateDraft}
              >
                开始领悟
              </Button>
            </div>
          )}
        </div>

        <div className="tech-research-tips">
          <div>1. 洞府研修需境界达到 {status?.unlockRealm ?? '--'} 后开启，未达门槛时无法开始领悟。</div>
          <div>2. 每次开始领悟固定消耗 {status ? currentFragmentCost : '--'} 页功法残页，残页会从背包与仓库中统一扣除。</div>
          <div>3. {cooldownDisplay.ruleText}</div>
          <div>4. 草稿过期未抄写时，只返还本次消耗的一半功法残页。</div>
          <div>5. 结果进入研修页后即视为已查看，抄写前仍可在此处查看草稿详情。</div>
          {hasCooldownBypassCapability && status ? (
            <div>6. {status.cooldownBypassTokenItemName}仅对当前这次推演生效，每次启用都会额外消耗 {status.cooldownBypassTokenCost} 枚。</div>
          ) : null}
        </div>

        <div className="tech-subtitle">当前研修结果</div>
        {loading ? <div className="tech-empty">加载中...</div> : null}
        {!loading && panelView.kind === 'empty' ? (
          <div className="tech-empty">暂无研修结果，点击“开始领悟”开始推演</div>
        ) : null}
        {!loading && panelView.kind === 'pending' ? (
          <div className="tech-research-status-card is-pending">
            <div className="tech-research-status-title">正在推演功法</div>
            <div className="tech-research-status-desc">
              推演可能需要较长时间，请耐心等待结果。当前推演完成前无法开启新的洞府研修。
            </div>
            <div className="tech-research-status-meta">
              {renderTechniqueResearchBurningWordTag(panelView.job.burningWordPrompt)}
              <Tag color="processing">推演中</Tag>
              <Tag color="default">任务 #{panelView.job.generationId}</Tag>
            </div>
          </div>
        ) : null}
        {!loading && panelView.kind === 'failed' ? (
          <div className="tech-research-status-card is-failed">
            <div className="tech-research-status-title">本次洞府研修未能成法</div>
            <div className="tech-research-status-meta">
              {renderTechniqueResearchBurningWordTag(panelView.job.burningWordPrompt)}
            </div>
            <div className="tech-research-status-desc">{panelView.errorMessage}</div>
            <div className="tech-research-status-foot">本次结果已结束，可在条件满足时重新开始领悟。</div>
          </div>
        ) : null}
        {!loading && panelView.kind === 'draft' ? (
          <div className="tech-research-draft">
            <div className="tech-research-draft-head">
              <div className="tech-research-draft-head-main">
                <div className="tech-research-draft-name">{panelView.preview.aiSuggestedName}</div>
                <div className="tech-research-draft-meta">
                  <Tag className={`tech-research-quality-tag ${getItemQualityTagClassName(panelView.preview.quality)}`}>
                    {getItemQualityLabel(panelView.preview.quality)}
                  </Tag>
                  <Tag color="default">{panelView.preview.type}</Tag>
                  <Tag color="default">最高{panelView.preview.maxLayer}层</Tag>
                  {renderTechniqueResearchBurningWordTag(panelView.job.burningWordPrompt)}
                </div>
              </div>
              <div className="tech-research-draft-expire">
                草稿过期时间：{panelView.job.draftExpireAt ? new Date(panelView.job.draftExpireAt).toLocaleString() : '--'}
              </div>
            </div>
            <div className="tech-research-draft-desc">{panelView.preview.description || '暂无描述'}</div>
            {panelView.preview.longDesc ? (
              <div className="tech-research-draft-long-desc">{panelView.preview.longDesc}</div>
            ) : null}
            <div className="tech-research-skill-list">
              {panelView.preview.skills.map((skill) => {
                const previewSkill = mapResearchPreviewSkillToDetail(skill);
                return (
                  <div key={skill.id} className="tech-research-skill-card">
                    {renderSkillCardDetails(previewSkill)}
                  </div>
                );
              })}
            </div>
            <div className="tech-research-actions tech-research-actions--draft-result">
              <Button
                danger
                className="tech-research-discard-button"
                loading={discardSubmitting}
                onClick={() => onDiscardDraft(panelView.job.generationId)}
              >
                放弃
              </Button>
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
