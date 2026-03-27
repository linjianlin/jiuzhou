/**
 * 移动端伙伴详情抽屉回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定移动端伙伴详情预览已经切换到统一 Drawer 容器，避免后续又回退到自定义 fixed Sheet。
 * 2. 做什么：覆盖购买场景下的标题、伙伴名称与价格文案，确保容器替换后关键信息仍然完整。
 * 3. 不做什么：不验证 antd Drawer 动画与 Portal，也不覆盖功法二级抽屉打开逻辑。
 *
 * 输入 / 输出：
 * - 输入：一份最小可渲染的 `PartnerDisplayDto` 与购买参数。
 * - 输出：静态 HTML 片段，需包含统一 Drawer 标题与伙伴详情文案。
 *
 * 数据流 / 状态流：
 * `PartnerPreviewOverlay` / 坊市购买入口 -> `MarketPartnerPreviewSheet` -> 统一移动端 Drawer。
 *
 * 复用设计说明：
 * 1. 通过 mock `antd` 容器，只锁定本组件与统一抽屉协议，不把测试耦合到第三方 DOM 细节。
 * 2. 一旦未来其他伙伴移动端预览也复用该容器，这个测试能一起兜住样式壳层回退问题。
 *
 * 关键边界条件与坑点：
 * 1. 需要显式断言旧的 `market-list-sheet-mask` 不再出现，否则容易只是“外面再包一层 Drawer”，实际旧壳层仍残留。
 * 2. 价格和按钮文案必须保留，避免改容器时把购买区意外丢掉。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PartnerDisplayDto } from '../../../../../services/api';
import MarketPartnerPreviewSheet from '../MarketPartnerPreviewSheet';

vi.mock('antd', () => ({
  Drawer: ({
    open,
    title,
    className,
    children,
  }: {
    open: boolean;
    title: string;
    className?: string;
    children: unknown;
  }) => (open ? <div className={className} data-title={title}>{children}</div> : null),
  Button: ({
    children,
    className,
    disabled,
  }: {
    children: unknown;
    className?: string;
    disabled?: boolean;
  }) => <button className={className} disabled={disabled}>{children}</button>,
}));

const createPartner = (): PartnerDisplayDto => ({
  id: 1,
  partnerDefId: 'partner-heilinjiao',
  name: '墨鳞蛟',
  nickname: '',
  description: '覆着乌墨细鳞，常缠在主人肩背间吐雾护身。',
  avatar: '/assets/partner/heilinjiao.png',
  element: 'shui',
  role: '雾卫',
  quality: '玄',
  level: 1,
  currentEffectiveLevel: 1,
  progressExp: 0,
  nextLevelCostExp: 10,
  slotCount: 1,
  isActive: false,
  obtainedFrom: null,
  growth: {
    max_qixue: 1,
    wugong: 1,
    fagong: 1,
    wufang: 1,
    fafang: 1,
    sudu: 1,
  },
  levelAttrGains: {
    max_qixue: 1,
    wugong: 1,
    fagong: 1,
    wufang: 1,
    fafang: 1,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    sudu: 1,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 0,
    lingqi_huifu: 0,
  },
  computedAttrs: {
    qixue: 10,
    max_qixue: 10,
    lingqi: 10,
    max_lingqi: 10,
    wugong: 10,
    fagong: 10,
    wufang: 10,
    fafang: 10,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    sudu: 10,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 0,
    lingqi_huifu: 0,
  },
  techniques: [],
});

describe('MarketPartnerPreviewSheet', () => {
  it('移动端伙伴详情应使用统一 Drawer 容器', () => {
    const html = renderToStaticMarkup(
      <MarketPartnerPreviewSheet
        partner={createPartner()}
        unitPrice={1}
        sellerCharacterId={2}
        myCharacterId={1}
        onClose={() => {}}
        onBuy={() => {}}
      />,
    );

    expect(html).toContain('market-partner-preview-drawer');
    expect(html).toContain('伙伴详情');
    expect(html).toContain('墨鳞蛟');
    expect(html).toContain('一口价（灵石）');
    expect(html).not.toContain('market-list-sheet-mask');
  });
});
