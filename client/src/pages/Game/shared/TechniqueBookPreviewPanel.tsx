/**
 * 功法书预览面板
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染功法书预览所需的最小信息集合，只展示名称、品质、描述与可学习技能。
 * 2. 做什么：复用共享 `TechniqueSkillSection`，让世界广播、后续其他功法书预览入口看到同一套技能卡片结构。
 * 3. 不做什么：不展示功法层数、解锁状态、升层消耗或技能升级进度，也不处理请求和弹层开关。
 *
 * 输入 / 输出：
 * - 输入：`detail` 功法书预览视图；`isMobile` 当前是否移动端。
 * - 输出：可直接挂进 Modal / Drawer 的预览节点；无数据时输出空态。
 *
 * 数据流 / 状态流：
 * `useTechniquePreview` -> 本组件 -> 世界频道功法书预览浮层。
 *
 * 复用设计说明：
 * 1. “描述 + 可学习技能”是功法书详情的稳定展示口径，集中到这里后，聊天广播不需要复制背包/坊市的展示结构。
 * 2. 组件只消费纯视图对象，不关心数据来自世界广播还是其他入口，后续复用时无需再接触接口 DTO。
 *
 * 关键边界条件与坑点：
 * 1. 功法书预览不能再透出层数或解锁态，否则会把“书籍预览”和“已学功法详情”重新混在一起。
 * 2. 移动端与桌面端都必须走同一份技能区组件，只切换 variant，避免两端技能文案再次分叉。
 */
import { Tag } from 'antd';
import type { FC } from 'react';
import { getItemQualityLabel, getItemQualityTagClassName } from './itemQuality';
import { TechniqueSkillSection } from './TechniqueSkillSection';
import type { TechniqueBookPreviewView } from './techniqueBookPreview';
import './TechniqueDetailPanel.scss';
import './TechniqueBookPreviewPanel.scss';

type TechniqueBookPreviewPanelProps = {
  detail: TechniqueBookPreviewView | null;
  isMobile: boolean;
  emptyText?: string;
};

const TechniqueBookPreviewPanel: FC<TechniqueBookPreviewPanelProps> = ({
  detail,
  isMobile,
  emptyText = '未找到功法书预览',
}) => {
  if (!detail) {
    return <div className="tech-empty">{emptyText}</div>;
  }

  return (
    <div className="tech-detail tech-book-preview">
      <div className="tech-detail-header">
        <img className="tech-detail-icon" src={detail.icon} alt={detail.name} />
        <div className="tech-detail-meta">
          <div className="tech-detail-name">
            <span>{detail.name}</span>
            <Tag className={getItemQualityTagClassName(detail.quality)}>
              {getItemQualityLabel(detail.quality)}
            </Tag>
          </div>
        </div>
      </div>

      <div className="tech-detail-desc">{detail.desc || '暂无描述'}</div>

      <TechniqueSkillSection
        title="可学习技能"
        emptyText="该功法暂无可展示技能"
        skills={detail.skills}
        loading={false}
        error={null}
        variant={isMobile ? 'mobile' : 'desktop'}
      />
    </div>
  );
};

export default TechniqueBookPreviewPanel;
