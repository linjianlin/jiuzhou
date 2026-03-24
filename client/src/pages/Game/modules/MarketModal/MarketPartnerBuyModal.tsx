import React from 'react';
import { Modal, Button, Tag } from 'antd';
import type { PartnerDisplayDto } from '../../../../services/api';
import {
  buildPartnerCombatAttrRows,
  formatPartnerElementLabel,
  hasPartnerLevelLimitApplied,
  resolvePartnerAvatar,
} from '../../shared/partnerDisplay';
import { getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName } from '../../shared/itemQuality';

interface MarketPartnerBuyModalProps {
  partner: PartnerDisplayDto | null;
  unitPrice?: number;
  sellerCharacterId?: number;
  myCharacterId?: number | null;
  onClose: () => void;
  onBuy?: () => void;
}

const MarketPartnerBuyModal: React.FC<MarketPartnerBuyModalProps> = ({
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
    <Modal
      open={!!partner}
      onCancel={onClose}
      footer={null}
      title="伙伴详情"
      centered
      width={760}
      destroyOnHidden
      className="market-partner-buy-modal"
      styles={{
        body: { padding: '0 24px 24px 24px' }
      }}
    >
      <div className="market-list-detail-card" style={{ padding: 0, border: 'none', background: 'transparent' }}>
        <div className="market-list-detail-head" style={{ padding: '0 0 16px 0', borderBottom: '1px solid var(--border-color-soft)' }}>
          <div className="market-list-detail-head-main">
            <img className={`market-list-detail-icon market-partner-avatar--detail`} src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
            <div className="market-list-detail-meta">
              <div className="market-list-detail-name">{partner.nickname || partner.name}</div>
              <div className="market-list-detail-tags">
                <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(partner.quality)}`}>{partner.quality}</Tag>
                <Tag className={`market-tag ${getElementToneClassName(partner.element)}`}>{formatPartnerElementLabel(partner.element)}</Tag>
                <Tag className="market-tag">{partner.role}</Tag>
                <Tag className="market-tag">等级 {partner.level}</Tag>
                {hasPartnerLevelLimitApplied(partner) ? <Tag className="market-tag">生效 {partner.currentEffectiveLevel}</Tag> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="market-list-detail-scroll" style={{ padding: '16px 0', display: 'flex', flexDirection: 'row', gap: '24px' }}>
          <div className="market-list-detail-section" style={{ flex: '0 0 300px', paddingRight: '8px' }}>
            <div className="market-list-detail-title">属性</div>
            <div className="market-list-detail-attr-grid" style={{ gap: '12px 12px' }}>
              {buildPartnerCombatAttrRows(partner).map((item) => (
                <div key={item.key} className="market-list-detail-line market-partner-attr-row">
                  <span className="market-partner-attr-row__label">{item.label}</span>
                  <span className="market-partner-attr-row__value">{item.valueText}</span>
                  {item.growthText ? (
                    <span className="market-partner-attr-row__growth">+ {item.growthText}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="market-list-detail-section" style={{ flex: 1, paddingRight: '8px', borderLeft: '1px solid var(--border-color-soft)', paddingLeft: '24px' }}>
            <div className="market-list-detail-title">功法</div>
            <div className="market-partner-technique-grid" style={{ gridTemplateColumns: '1fr' }}>
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

        {unitPrice !== undefined ? (
          <div className="market-list-form" style={{ padding: '16px 0 0 0', marginTop: 'auto', borderTop: '1px solid var(--border-color-soft)' }}>
            <div className="market-list-row" style={{ justifyContent: 'space-between' }}>
              <div className="market-list-k">一口价</div>
              <div className="market-list-v" style={{ fontWeight: 800, color: 'var(--warning-color)', fontSize: '16px' }}>
                {unitPrice.toLocaleString()} 灵石
              </div>
            </div>
            <div className="market-list-actions">
              <Button type="primary" disabled={!canBuy} onClick={onBuy} block>
                {isMyOwn ? '不可购买自己的上架' : '确认购买'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
};

export default MarketPartnerBuyModal;
