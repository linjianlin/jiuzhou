import React from 'react';
import type { PartnerDisplayDto } from '../../../../services/api';
import {
  buildPartnerCombatAttrRows,
  formatPartnerElementLabel,
  hasPartnerLevelLimitApplied,
  resolvePartnerAvatar,
} from '../../shared/partnerDisplay';
import { getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName } from '../../shared/itemQuality';

interface MarketPartnerPreviewSheetProps {
  partner: PartnerDisplayDto | null;
  unitPrice?: number;
  sellerCharacterId?: number;
  myCharacterId?: number | null;
  onClose: () => void;
  onBuy?: () => void;
}

const MarketPartnerPreviewSheet: React.FC<MarketPartnerPreviewSheetProps> = ({
  partner,
  unitPrice,
  sellerCharacterId,
  myCharacterId,
  onClose,
  onBuy,
}) => {
  if (!partner) return null;

  const isMyOwn = myCharacterId !== null && myCharacterId !== undefined && sellerCharacterId === myCharacterId;
  const canBuy = !!onBuy && !isMyOwn;

  return (
    <>
      <div className="market-list-sheet-mask" onClick={onClose} />
      <div className="market-list-sheet">
        <div className="market-list-sheet-handle">
          <div className="market-list-sheet-bar" />
        </div>

        {/* 头部 */}
        <div className="market-list-sheet-head">
          <div className="market-list-sheet-head-main">
            <div className="market-list-sheet-icon-box">
              <img className="market-list-sheet-icon-img" style={{ borderRadius: '12px', width: '100%', height: '100%' }} src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
            </div>
            <div className="market-list-sheet-meta">
              <div className="market-list-sheet-name">
                {partner.nickname || partner.name}
              </div>
              <div className="market-list-sheet-tags">
                <span className={`market-list-sheet-tag market-list-sheet-tag--quality ${getItemQualityTagClassName(partner.quality)}`}>
                  {partner.quality}
                </span>
                <span className={`market-list-sheet-tag ${getElementToneClassName(partner.element)}`}>{formatPartnerElementLabel(partner.element)}</span>
                <span className="market-list-sheet-tag">{partner.role}</span>
                <span className="market-list-sheet-tag">等级 {partner.level}</span>
                {hasPartnerLevelLimitApplied(partner) ? (
                  <span className="market-list-sheet-tag">生效 {partner.currentEffectiveLevel}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* 详情 */}
        <div className="market-list-sheet-body">
          <div className="market-list-sheet-section">
            <div className="market-list-sheet-section-title">属性</div>
            <div className="market-list-sheet-effect-list market-list-sheet-effect-list--partner-attrs">
              {buildPartnerCombatAttrRows(partner).map((item) => (
                <div key={item.key} className="market-list-sheet-effect-chip market-partner-attr-row">
                  <span className="market-partner-attr-row__label">{item.label}</span>
                  <span className="market-partner-attr-row__value">{item.valueText}</span>
                  {item.growthText ? (
                    <span className="market-partner-attr-row__growth">+ {item.growthText}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="market-list-sheet-section">
            <div className="market-list-sheet-section-title">功法</div>
            <div className="market-partner-technique-grid">
              {partner.techniques.length > 0 ? (
                partner.techniques.map((tech) => (
                  <div key={tech.techniqueId} className="market-partner-technique-cell">
                    <div className="market-partner-technique-name">{tech.name} <span className="market-partner-technique-level">一层</span></div>
                    <div className="market-partner-technique-desc">{tech.description || '暂无描述'}</div>
                  </div>
                ))
              ) : (
                <div className="market-list-detail-text">暂无功法</div>
              )}
            </div>
          </div>
        </div>

        {/* 购买操作区 */}
        {unitPrice !== undefined ? (
          <div className="market-list-sheet-form market-list-sheet-form--partner-buy">
            <div className="market-list-sheet-price-card">
              <span className="market-list-sheet-label market-list-sheet-label--compact">一口价（灵石）</span>
              <span className="market-list-sheet-value market-list-sheet-value--compact" style={{ fontWeight: 800, color: 'var(--warning-color)' }}>
                {unitPrice.toLocaleString()}
              </span>
            </div>
            <div className="market-list-sheet-actions market-list-sheet-actions--partner-buy">
              <button
                className="market-list-sheet-btn market-list-sheet-btn--partner-buy is-primary"
                disabled={!canBuy}
                onClick={onBuy}
              >
                {isMyOwn ? '不可购买自己的上架' : '确认购买'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
};

export default MarketPartnerPreviewSheet;
