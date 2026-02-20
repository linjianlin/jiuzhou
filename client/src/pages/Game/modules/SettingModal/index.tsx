import { App, Button, Input, Menu, Modal, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  getCharacterInfo,
  updateCharacterAutoDisassemble,
  type AutoDisassembleRuleDto,
  type AutoDisassembleRulesDto,
} from '../../../../services/api';
import { emitThemeModeChange, getStoredThemeMode, persistThemeMode, type ThemeMode } from '../../../../constants/theme';
import {
  AUTO_DISASSEMBLE_CATEGORY_OPTIONS,
  AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS,
  normalizeAutoDisassembleCategoryList,
  normalizeAutoDisassembleSubCategoryList,
} from '../../shared/autoDisassembleFilters';
import { loadGameItemTaxonomy, useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import { useIsMobile } from '../../shared/responsive';
import './index.scss';

type SettingKey = 'base' | 'disassemble' | 'cdk';

interface SettingModalProps {
  open: boolean;
  onClose: () => void;
}

interface AutoDisassembleRuleDraft {
  id: number;
  categories: string[];
  subCategories: string[];
  excludedSubCategories: string[];
  includeNameKeywordsText: string;
  excludeNameKeywordsText: string;
  maxQualityRank: number;
}

interface AutoDisassembleRuleDraftContent {
  categories: string[];
  subCategories: string[];
  excludedSubCategories: string[];
  includeNameKeywordsText: string;
  excludeNameKeywordsText: string;
  maxQualityRank: number;
}

const CDK_STORAGE_KEY = 'cdk_redeemed_v1';

const createDefaultAutoDisassembleRuleDraftContent = (): AutoDisassembleRuleDraftContent => {
  return {
    categories: ['equipment'],
    subCategories: [],
    excludedSubCategories: [],
    includeNameKeywordsText: '',
    excludeNameKeywordsText: '',
    maxQualityRank: 1,
  };
};

const createAutoDisassembleRuleDraft = (
  id: number,
  content?: AutoDisassembleRuleDraftContent
): AutoDisassembleRuleDraft => {
  const safeContent = content ?? createDefaultAutoDisassembleRuleDraftContent();
  return {
    id,
    categories: [...safeContent.categories],
    subCategories: [...safeContent.subCategories],
    excludedSubCategories: [...safeContent.excludedSubCategories],
    includeNameKeywordsText: safeContent.includeNameKeywordsText,
    excludeNameKeywordsText: safeContent.excludeNameKeywordsText,
    maxQualityRank: safeContent.maxQualityRank,
  };
};

const loadRedeemedCdks = () => {
  const raw = localStorage.getItem(CDK_STORAGE_KEY);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((x) => typeof x === 'string'));
  } catch {
    return new Set<string>();
  }
};

const saveRedeemedCdks = (set: Set<string>) => {
  localStorage.setItem(CDK_STORAGE_KEY, JSON.stringify(Array.from(set)));
};

const clampQualityRank = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(4, n));
};

const parseCommaList = (raw: string, toLower: boolean = false): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(',')) {
    const value = toLower ? token.trim().toLowerCase() : token.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const stringifyList = (raw: unknown): string => {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0)
    .join(', ');
};

const normalizeAutoDisassembleRuleDraftContent = (raw: unknown): AutoDisassembleRuleDraftContent => {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const categories = normalizeAutoDisassembleCategoryList(row.categories);
  return {
    categories: categories.length > 0 ? categories : ['equipment'],
    subCategories: normalizeAutoDisassembleSubCategoryList(row.subCategories),
    excludedSubCategories: normalizeAutoDisassembleSubCategoryList(row.excludedSubCategories),
    includeNameKeywordsText: stringifyList(row.includeNameKeywords),
    excludeNameKeywordsText: stringifyList(row.excludeNameKeywords),
    maxQualityRank: clampQualityRank(row.maxQualityRank),
  };
};

const normalizeAutoDisassembleRuleDraftContentList = (raw: unknown): AutoDisassembleRuleDraftContent[] => {
  if (!Array.isArray(raw)) return [createDefaultAutoDisassembleRuleDraftContent()];
  const out: AutoDisassembleRuleDraftContent[] = [];
  for (const row of raw) {
    out.push(normalizeAutoDisassembleRuleDraftContent(row));
    if (out.length >= 20) break;
  }
  if (out.length <= 0) {
    return [createDefaultAutoDisassembleRuleDraftContent()];
  }
  return out;
};

const buildAutoDisassembleRulePayload = (rule: AutoDisassembleRuleDraft): AutoDisassembleRuleDto => {
  const categories = normalizeAutoDisassembleCategoryList(rule.categories);
  const subCategories = normalizeAutoDisassembleSubCategoryList(rule.subCategories);
  const excludedSubCategories = normalizeAutoDisassembleSubCategoryList(rule.excludedSubCategories);
  const includeNameKeywords = parseCommaList(rule.includeNameKeywordsText, true);
  const excludeNameKeywords = parseCommaList(rule.excludeNameKeywordsText, true);

  return {
    ...(categories.length > 0 ? { categories } : {}),
    ...(subCategories.length > 0 ? { subCategories } : {}),
    ...(excludedSubCategories.length > 0 ? { excludedSubCategories } : {}),
    ...(includeNameKeywords.length > 0 ? { includeNameKeywords } : {}),
    ...(excludeNameKeywords.length > 0 ? { excludeNameKeywords } : {}),
    maxQualityRank: clampQualityRank(rule.maxQualityRank),
  };
};

const SettingModal: React.FC<SettingModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  useGameItemTaxonomy(open);
  const [activeKey, setActiveKey] = useState<SettingKey>('base');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [autoDisassembleEnabled, setAutoDisassembleEnabled] = useState(false);
  const [autoDisassembleRules, setAutoDisassembleRules] = useState<AutoDisassembleRuleDraft[]>([
    createAutoDisassembleRuleDraft(1),
  ]);
  const [, setAutoDisassembleRuleIdSeed] = useState(2);
  const [autoDisassembleSaving, setAutoDisassembleSaving] = useState(false);
  const [autoDisassembleLoading, setAutoDisassembleLoading] = useState(false);
  const [cdk, setCdk] = useState('');
  const isMobile = useIsMobile();

  const menuItems = useMemo(
    () => [
      { key: 'base', label: '基础设置' },
      { key: 'disassemble', label: '自动分解' },
      { key: 'cdk', label: 'CDK兑换' },
    ],
    []
  );

  const redeemCdk = () => {
    const code = cdk.trim();
    if (!code) {
      message.warning('请输入CDK');
      return;
    }
    const redeemed = loadRedeemedCdks();
    if (redeemed.has(code)) {
      message.info('该CDK已兑换过');
      return;
    }
    redeemed.add(code);
    saveRedeemedCdks(redeemed);
    setCdk('');
    message.success('兑换成功');
  };

  const toggleDarkTheme = (enabled: boolean) => {
    const nextMode: ThemeMode = enabled ? 'dark' : 'light';
    setThemeMode(nextMode);
    persistThemeMode(nextMode);
    emitThemeModeChange(nextMode);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAutoDisassembleLoading(true);
    void (async () => {
      try {
        await loadGameItemTaxonomy();
        if (cancelled) return;
        const res = await getCharacterInfo();
        if (!res.success || !res.data?.character || cancelled) return;
        const character = res.data.character;
        setAutoDisassembleEnabled(Boolean(character.auto_disassemble_enabled));

        const rawRules = normalizeAutoDisassembleRuleDraftContentList(character.auto_disassemble_rules);
        setAutoDisassembleRules(rawRules.map((rule, index) => createAutoDisassembleRuleDraft(index + 1, rule)));
        setAutoDisassembleRuleIdSeed(rawRules.length + 1);
      } catch {
      } finally {
        if (!cancelled) {
          setAutoDisassembleLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const buildAutoDisassembleRulesPayload = (overrides?: {
    rules?: AutoDisassembleRuleDraft[];
  }): AutoDisassembleRulesDto => {
    const sourceRules = overrides?.rules ?? autoDisassembleRules;
    const payload = sourceRules.map((rule) => buildAutoDisassembleRulePayload(rule));
    if (payload.length > 0) return payload;
    return [{ categories: ['equipment'], maxQualityRank: 1 }];
  };

  const saveAutoDisassemble = async (
    nextEnabled: boolean,
    nextRules: AutoDisassembleRulesDto,
    rollback: () => void,
  ) => {
    setAutoDisassembleSaving(true);
    try {
      const res = await updateCharacterAutoDisassemble(nextEnabled, nextRules);
      if (!res.success) throw new Error(res.message || '设置保存失败');
      message.success('自动分解设置已保存');
    } catch (error) {
      rollback();
      const e = error as { message?: string };
      message.error(e.message || '设置保存失败');
    } finally {
      setAutoDisassembleSaving(false);
    }
  };

  const handleAutoDisassembleEnabledChange = (next: boolean) => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const prevEnabled = autoDisassembleEnabled;
    setAutoDisassembleEnabled(next);
    void saveAutoDisassemble(next, buildAutoDisassembleRulesPayload(), () =>
      setAutoDisassembleEnabled(prevEnabled)
    );
  };

  const handleSaveAdvancedRules = () => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const rules = buildAutoDisassembleRulesPayload();
    void saveAutoDisassemble(autoDisassembleEnabled, rules, () => undefined);
  };

  const handleAddAutoDisassembleRule = () => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    setAutoDisassembleRuleIdSeed((seed) => {
      setAutoDisassembleRules((prev) => [...prev, createAutoDisassembleRuleDraft(seed)]);
      return seed + 1;
    });
  };

  const handleRemoveAutoDisassembleRule = (ruleId: number) => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    setAutoDisassembleRules((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((rule) => rule.id !== ruleId);
    });
  };

  const handleUpdateAutoDisassembleRule = (
    ruleId: number,
    patch: Partial<Omit<AutoDisassembleRuleDraft, 'id'>>,
  ) => {
    setAutoDisassembleRules((prev) =>
      prev.map((rule) => {
        if (rule.id !== ruleId) return rule;
        return {
          ...rule,
          ...patch,
        };
      })
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width="min(860px, calc(100vw - 16px))"
      className="setting-modal"
      destroyOnHidden
    >
      <div className={`setting-modal-body ${isMobile ? 'is-mobile' : ''}`}>
        <aside className="setting-left">
          <Typography.Title level={5} className="setting-left-title">
            设置
          </Typography.Title>
          <Menu
            mode={isMobile ? 'horizontal' : 'inline'}
            items={menuItems}
            selectedKeys={[activeKey]}
            onClick={(e) => setActiveKey(e.key as SettingKey)}
          />
        </aside>

        <section className="setting-right">
          {activeKey === 'base' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                基础设置
              </Typography.Title>
              <div className="setting-row">
                <Typography.Text>暗黑主题</Typography.Text>
                <Switch checked={themeMode === 'dark'} onChange={toggleDarkTheme} />
              </div>
            </Space>
          ) : null}

          {activeKey === 'disassemble' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                自动分解
              </Typography.Title>
              <div className="setting-row">
                <Typography.Text>自动分解物品</Typography.Text>
                <Switch
                  checked={autoDisassembleEnabled}
                  loading={autoDisassembleLoading || autoDisassembleSaving}
                  onChange={handleAutoDisassembleEnabledChange}
                />
              </div>

              <Typography.Text type="secondary" className="setting-rule-tip">
                可新增多条规则。自动分解采用"或（OR）"判断：命中任意一条规则即会分解。最高品质为规则级配置，
                每条规则独立生效。
              </Typography.Text>

              {autoDisassembleRules.map((rule, index) => (
                <div className="setting-rule-card" key={rule.id}>
                  <div className="setting-rule-header">
                    <Typography.Text strong>{`规则 ${index + 1}`}</Typography.Text>
                    <Button
                      danger
                      type="text"
                      size="small"
                      disabled={autoDisassembleLoading || autoDisassembleSaving || autoDisassembleRules.length <= 1}
                      onClick={() => handleRemoveAutoDisassembleRule(rule.id)}
                    >
                      删除规则
                    </Button>
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>本规则最高品质</Typography.Text>
                    <Select
                      value={rule.maxQualityRank}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      options={[
                        { label: '黄品', value: 1 },
                        { label: '玄品', value: 2 },
                        { label: '地品', value: 3 },
                        { label: '天品', value: 4 },
                      ]}
                      onChange={(next) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          maxQualityRank: clampQualityRank(next),
                        })
                      }
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>自动分解品类</Typography.Text>
                    <Select
                      mode="multiple"
                      value={rule.categories}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      options={AUTO_DISASSEMBLE_CATEGORY_OPTIONS}
                      onChange={(next) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          categories: normalizeAutoDisassembleCategoryList(next),
                        })
                      }
                      style={{ width: '100%' }}
                      placeholder="未选择时默认仅装备"
                    />
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>包含子类</Typography.Text>
                    <Select
                      mode="multiple"
                      value={rule.subCategories}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      options={AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS}
                      onChange={(next) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          subCategories: normalizeAutoDisassembleSubCategoryList(next),
                        })
                      }
                      style={{ width: '100%' }}
                      placeholder="请选择需要包含的子类"
                    />
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>排除子类</Typography.Text>
                    <Select
                      mode="multiple"
                      value={rule.excludedSubCategories}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      options={AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS}
                      onChange={(next) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          excludedSubCategories: normalizeAutoDisassembleSubCategoryList(next),
                        })
                      }
                      style={{ width: '100%' }}
                      placeholder="请选择需要排除的子类"
                    />
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>包含名称关键词（逗号分隔）</Typography.Text>
                    <Input
                      value={rule.includeNameKeywordsText}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      onChange={(e) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          includeNameKeywordsText: e.target.value,
                        })
                      }
                      placeholder="如：丹, 剑, 残页"
                    />
                  </div>

                  <div className="setting-row setting-row-column">
                    <Typography.Text>排除名称关键词（逗号分隔）</Typography.Text>
                    <Input
                      value={rule.excludeNameKeywordsText}
                      disabled={autoDisassembleLoading || autoDisassembleSaving}
                      onChange={(e) =>
                        handleUpdateAutoDisassembleRule(rule.id, {
                          excludeNameKeywordsText: e.target.value,
                        })
                      }
                      placeholder="如：任务, 钥匙"
                    />
                  </div>
                </div>
              ))}

              <Button
                disabled={autoDisassembleLoading || autoDisassembleSaving || autoDisassembleRules.length >= 20}
                onClick={handleAddAutoDisassembleRule}
                style={{ alignSelf: 'flex-start' }}
              >
                新增一条规则
              </Button>

              <Button
                type="primary"
                loading={autoDisassembleSaving}
                disabled={autoDisassembleLoading || autoDisassembleSaving}
                onClick={handleSaveAdvancedRules}
                style={{ alignSelf: 'flex-end' }}
              >
                保存自动分解规则
              </Button>
            </Space>
          ) : null}

          {activeKey === 'cdk' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                CDK兑换
              </Typography.Title>
              {isMobile ? (
                <Space direction="vertical" size={8} className="setting-cdk-mobile">
                  <Input value={cdk} onChange={(e) => setCdk(e.target.value)} placeholder="请输入CDK" />
                  <Button type="primary" onClick={redeemCdk} block>
                    兑换
                  </Button>
                </Space>
              ) : (
                <Space.Compact style={{ width: '100%' }}>
                  <Input value={cdk} onChange={(e) => setCdk(e.target.value)} placeholder="请输入CDK" />
                  <Button type="primary" onClick={redeemCdk}>
                    兑换
                  </Button>
                </Space.Compact>
              )}
            </Space>
          ) : null}
        </section>
      </div>
    </Modal>
  );
};

export default SettingModal;
