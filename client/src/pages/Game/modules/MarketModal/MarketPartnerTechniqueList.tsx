/**
 * 坊市伙伴功法列表共享组件
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中渲染坊市伙伴详情里的功法名称、当前层数与描述，供上架预览、购买详情、移动端预览三类入口复用。
 * 2. 做什么：把“功法层数展示必须读取真实 `currentLayer/maxLayer`”收敛到单一入口，避免多个 JSX 分支再次各写一份字符串。
 * 3. 不做什么：不处理坊市购买/上架按钮，也不负责伙伴属性区域布局。
 *
 * 输入/输出：
 * - 输入：伙伴功法列表，以及可选的单列布局开关。
 * - 输出：统一的坊市功法列表 DOM 结构；无功法时输出占位文案。
 *
 * 数据流/状态流：
 * 坊市伙伴 DTO -> 调用方传入 `techniques` -> 本组件格式化层数字样并渲染 -> 多个坊市详情入口共用。
 *
 * 关键边界条件与坑点：
 * 1. 层数字样必须始终从 DTO 实际值读取，不能再写死“第一层”，否则坊市会与伙伴面板展示脱节。
 * 2. 单列与双列仅允许通过布局参数控制，内容结构本身保持一致，避免后续修文案时又在不同弹层漏改一处。
 */
import type { FC } from 'react';
import type { PartnerTechniqueDto } from '../../../../services/api';
import { formatPartnerTechniqueLayerLabel } from '../../shared/partnerDisplay';

interface MarketPartnerTechniqueListProps {
  techniques: PartnerTechniqueDto[];
  singleColumn?: boolean;
}

const MarketPartnerTechniqueList: FC<MarketPartnerTechniqueListProps> = ({
  techniques,
  singleColumn = false,
}) => {
  if (techniques.length <= 0) {
    return <div className="market-list-detail-text">暂无功法</div>;
  }

  return (
    <div
      className="market-partner-technique-grid"
      style={singleColumn ? { gridTemplateColumns: '1fr' } : undefined}
    >
      {techniques.map((technique) => (
        <div key={technique.techniqueId} className="market-partner-technique-cell">
          <div className="market-partner-technique-name">
            {technique.name}
            <span className="market-partner-technique-level">
              {formatPartnerTechniqueLayerLabel(technique)}
            </span>
          </div>
          <div className="market-partner-technique-desc">{technique.description || '暂无描述'}</div>
        </div>
      ))}
    </div>
  );
};

export default MarketPartnerTechniqueList;
