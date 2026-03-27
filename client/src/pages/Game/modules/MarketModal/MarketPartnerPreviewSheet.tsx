import React from 'react';
import { Button, Drawer } from 'antd';
import type { PartnerDisplayDto } from '../../../../services/api';
import {
  buildPartnerCombatAttrRows,
  formatPartnerElementLabel,
  hasPartnerLevelLimitApplied,
  resolvePartnerAvatar,
} from '../../shared/partnerDisplay';
import { getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName } from '../../shared/itemQuality';
import MarketPartnerTechniqueList from './MarketPartnerTechniqueList';
import './index.scss';

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
    <Drawer
      title="伙伴详情"
      placement="bottom"
      open={Boolean(partner)}
      onClose={onClose}
      height="82dvh"
      className="market-mobile-preview-drawer market-partner-preview-drawer"
      styles={{ body: { padding: '10px 12px 12px' } }}
    >
      <div className="market-mobile-preview">
        <div className="market-mobile-preview-content market-partner-preview-content">
          <div className="market-partner-preview-summary">
            <div className="market-partner-preview-head">
              <div className="market-partner-preview-icon-box">
                <img
                  className="market-partner-preview-icon-img"
                  src={resolvePartnerAvatar(partner.avatar)}
                  alt={partner.name}
                />
              </div>
              <div className="market-partner-preview-meta">
                <div className="market-partner-preview-name">
                  {partner.nickname || partner.name}
                </div>
                <div className="market-partner-preview-tags">
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
                {partner.description ? (
                  <div className="market-partner-preview-desc">{partner.description}</div>
                ) : null}
              </div>
            </div>
          </div>
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
            <MarketPartnerTechniqueList techniques={partner.techniques} skillDisplayMode="drawer" />
          </div>
        </div>

        {unitPrice !== undefined ? (
          <div className="market-mobile-preview-actions market-partner-preview-actions">
            <div className="market-list-sheet-price-card market-partner-preview-price-card">
              <span className="market-list-sheet-label market-list-sheet-label--compact">一口价（灵石）</span>
              <span className="market-list-sheet-value market-list-sheet-value--compact" style={{ fontWeight: 800, color: 'var(--warning-color)' }}>
                {unitPrice.toLocaleString()}
              </span>
            </div>
            <div className="market-partner-preview-action-row">
              <Button
                type="primary"
                block
                className="market-partner-preview-buy-btn"
                disabled={!canBuy}
                onClick={onBuy}
              >
                {isMyOwn ? '不可购买自己的上架' : '确认购买'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
};

export default MarketPartnerPreviewSheet;
