import { App, Button, Form, Input, Menu, Modal, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  commitBattleAvatarVisibilitySelection,
  getStoredBattleAvatarVisibility,
} from '../../../../constants/battleDisplay';
import {
  changePassword,
  getCharacterInfo,
  getUnifiedApiErrorMessage,
  notifyUnifiedApiError,
  redeemGiftCode,
  SILENT_API_REQUEST_CONFIG,
  updateCharacterAutoDisassemble,
  updateCharacterDungeonNoStaminaCost,
  type AutoDisassembleRuleDto,
  type AutoDisassembleRulesDto,
} from '../../../../services/api';
import { commitThemeModeSelection, getStoredThemeMode, type ThemeMode } from '../../../../constants/theme';
import {
  ACCOUNT_PASSWORD_MIN_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH_MESSAGE,
  ACCOUNT_PASSWORD_SAME_AS_CURRENT_MESSAGE,
  createConfirmPasswordValidator,
  createDistinctPasswordValidator,
} from '../../../shared/accountPasswordFormRules';
import {
  AUTO_DISASSEMBLE_CATEGORY_OPTIONS,
  buildAutoDisassembleSubCategoryOptionsByCategories,
  normalizeAutoDisassembleCategoryList,
  normalizeAutoDisassembleSubCategoryList,
} from '../../shared/autoDisassembleFilters';
import { loadGameItemTaxonomy, useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import { useIsMobile } from '../../shared/responsive';
import './index.scss';

type SettingKey = 'base' | 'security' | 'disassemble' | 'cdk';

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

interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

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

const clampQualityRank = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(4, n));
};

const normalizeCommaSeparatedText = (raw: string): string => {
  return raw.replace(/，/gu, ',');
};

const parseCommaList = (raw: string, toLower: boolean = false): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of normalizeCommaSeparatedText(raw).split(',')) {
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
    .join(',');
};

const normalizeKeywordText = (raw: string): string => {
  return stringifyList(parseCommaList(raw));
};

const normalizeAutoDisassembleRuleDraftKeywords = (
  rule: AutoDisassembleRuleDraft
): AutoDisassembleRuleDraft => {
  const includeNameKeywordsText = normalizeKeywordText(rule.includeNameKeywordsText);
  const excludeNameKeywordsText = normalizeKeywordText(rule.excludeNameKeywordsText);
  if (
    includeNameKeywordsText === rule.includeNameKeywordsText &&
    excludeNameKeywordsText === rule.excludeNameKeywordsText
  ) {
    return rule;
  }
  return {
    ...rule,
    includeNameKeywordsText,
    excludeNameKeywordsText,
  };
};

const normalizeAutoDisassembleRuleDraftList = (
  rules: AutoDisassembleRuleDraft[],
): AutoDisassembleRuleDraft[] => {
  let changed = false;
  const nextRules = rules.map((rule) => {
    const normalizedRule = normalizeAutoDisassembleRuleDraftKeywords(rule);
    if (normalizedRule !== rule) changed = true;
    return normalizedRule;
  });
  return changed ? nextRules : rules;
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
  const subCategories = normalizeRuleSubCategoriesBySelectedCategories(categories, rule.subCategories);
  const excludedSubCategories = normalizeRuleSubCategoriesBySelectedCategories(categories, rule.excludedSubCategories);
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

/**
 * 按规则内已选一级分类，清理“包含子类/排除子类”中的无效值。
 *
 * 作用：
 * - 让规则编辑态与实际命中语义一致，避免“一级分类=消耗品，但子类仍保留材料子类”的误配置。
 * - 将子类联动逻辑集中到一个函数，供品类切换与子类选择复用，减少重复判断分支。
 *
 * 输入：
 * - categoriesRaw：规则当前选择的一级分类列表。
 * - subCategoriesRaw：待归一化的子类列表（可来自旧规则或当前交互输入）。
 *
 * 输出：
 * - 去重、规范化且符合当前一级分类约束的子类列表。
 *
 * 关键边界条件：
 * 1) 当一级分类为空时，不额外裁剪子类，保持“未限制品类”规则可覆盖全量子类。
 * 2) 当一级分类存在时，仅保留该分类集合可见的子类值，防止保存无效组合。
 */
const normalizeRuleSubCategoriesBySelectedCategories = (
  categoriesRaw: unknown,
  subCategoriesRaw: unknown,
): string[] => {
  const normalizedCategories = normalizeAutoDisassembleCategoryList(categoriesRaw);
  const normalizedSubCategories = normalizeAutoDisassembleSubCategoryList(subCategoriesRaw);
  if (normalizedCategories.length <= 0) return normalizedSubCategories;
  const allowedValueSet = new Set(
    buildAutoDisassembleSubCategoryOptionsByCategories(normalizedCategories).map((option) => option.value)
  );
  return normalizedSubCategories.filter((value) => allowedValueSet.has(value));
};

const SettingModal: React.FC<SettingModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [changePasswordForm] = Form.useForm<ChangePasswordFormValues>();
  useGameItemTaxonomy(open);
  const [activeKey, setActiveKey] = useState<SettingKey>('base');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [battleAvatarVisible, setBattleAvatarVisible] = useState<boolean>(() => getStoredBattleAvatarVisibility());
  const [dungeonNoStaminaCostEnabled, setDungeonNoStaminaCostEnabled] = useState(false);
  const [dungeonNoStaminaCostSaving, setDungeonNoStaminaCostSaving] = useState(false);
  const [autoDisassembleEnabled, setAutoDisassembleEnabled] = useState(false);
  const [autoDisassembleRules, setAutoDisassembleRules] = useState<AutoDisassembleRuleDraft[]>([
    createAutoDisassembleRuleDraft(1),
  ]);
  const [, setAutoDisassembleRuleIdSeed] = useState(2);
  const [autoDisassembleSaving, setAutoDisassembleSaving] = useState(false);
  const [autoDisassembleLoading, setAutoDisassembleLoading] = useState(false);
  const [changePasswordSaving, setChangePasswordSaving] = useState(false);
  const [cdk, setCdk] = useState('');
  const [cdkRedeeming, setCdkRedeeming] = useState(false);
  const isMobile = useIsMobile();

  const menuItems = useMemo(
    () => [
      { key: 'base', label: '基础设置' },
      { key: 'security', label: '账号安全' },
      { key: 'disassemble', label: '自动分解' },
      { key: 'cdk', label: '兑换码' },
    ],
    []
  );

  const redeemCdk = async () => {
    const code = cdk.trim();
    if (!code) {
      message.warning('请输入兑换码');
      return;
    }
    if (cdkRedeeming) return;

    setCdkRedeeming(true);
    try {
      const result = await redeemGiftCode(code, SILENT_API_REQUEST_CONFIG);
      setCdk('');
      message.success(result.message || '兑换成功');
    } catch (error) {
      notifyUnifiedApiError(message, error, '兑换失败');
    } finally {
      setCdkRedeeming(false);
    }
  };

  const toggleDarkTheme = (enabled: boolean) => {
    const nextMode: ThemeMode = enabled ? 'dark' : 'light';
    setThemeMode(nextMode);
    commitThemeModeSelection(nextMode);
  };

  const toggleBattleAvatarVisible = (enabled: boolean) => {
    setBattleAvatarVisible(enabled);
    commitBattleAvatarVisibilitySelection(enabled);
  };

  const saveDungeonNoStaminaCost = async (nextEnabled: boolean, rollback: () => void) => {
    setDungeonNoStaminaCostSaving(true);
    try {
      const res = await updateCharacterDungeonNoStaminaCost(nextEnabled);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '设置保存失败'));
      message.success('秘境免体力设置已保存');
    } catch {
      rollback();
    } finally {
      setDungeonNoStaminaCostSaving(false);
    }
  };

  const handleDungeonNoStaminaCostEnabledChange = (next: boolean) => {
    if (autoDisassembleLoading || dungeonNoStaminaCostSaving) return;
    const prevEnabled = dungeonNoStaminaCostEnabled;
    setDungeonNoStaminaCostEnabled(next);
    void saveDungeonNoStaminaCost(next, () => setDungeonNoStaminaCostEnabled(prevEnabled));
  };

  useEffect(() => {
    if (!open) {
      changePasswordForm.resetFields();
    }
  }, [changePasswordForm, open]);

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
        setDungeonNoStaminaCostEnabled(Boolean(character.dungeon_no_stamina_cost));
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

  const handleChangePassword = async (values: ChangePasswordFormValues) => {
    setChangePasswordSaving(true);
    try {
      const response = await changePassword(
        values.currentPassword,
        values.newPassword,
        SILENT_API_REQUEST_CONFIG,
      );
      message.success(response.message || '密码修改成功');
      changePasswordForm.resetFields();
    } catch (error) {
      notifyUnifiedApiError(message, error, '修改密码失败');
    } finally {
      setChangePasswordSaving(false);
    }
  };

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
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '设置保存失败'));
      message.success('自动分解设置已保存');
    } catch (error) {
      rollback();
      void 0;
    } finally {
      setAutoDisassembleSaving(false);
    }
  };

  const handleAutoDisassembleEnabledChange = (next: boolean) => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const prevEnabled = autoDisassembleEnabled;
    const normalizedRules = normalizeAutoDisassembleRuleDraftList(autoDisassembleRules);
    if (normalizedRules !== autoDisassembleRules) {
      setAutoDisassembleRules(normalizedRules);
    }
    setAutoDisassembleEnabled(next);
    void saveAutoDisassemble(next, buildAutoDisassembleRulesPayload({ rules: normalizedRules }), () =>
      setAutoDisassembleEnabled(prevEnabled)
    );
  };

  const handleSaveAdvancedRules = () => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const normalizedRules = normalizeAutoDisassembleRuleDraftList(autoDisassembleRules);
    if (normalizedRules !== autoDisassembleRules) {
      setAutoDisassembleRules(normalizedRules);
    }
    const rules = buildAutoDisassembleRulesPayload({ rules: normalizedRules });
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
              <div className="setting-row">
                <div className="setting-row-main">
                  <Typography.Text>显示战斗头像</Typography.Text>
                  <Typography.Text type="secondary" className="setting-row-description">
                    控制战斗单位卡片上的头像背景图显示，不影响战斗外的角色与伙伴头像。
                  </Typography.Text>
                </div>
                <Switch checked={battleAvatarVisible} onChange={toggleBattleAvatarVisible} />
              </div>
              <div className="setting-row">
                <div className="setting-row-main">
                  <Typography.Text>秘境免体力模式</Typography.Text>
                  <Typography.Text type="secondary" className="setting-row-description">
                    开启后进入秘境不会消耗体力，但无论单人还是组队，都不会获得任何收益。
                  </Typography.Text>
                </div>
                <Switch
                  checked={dungeonNoStaminaCostEnabled}
                  loading={autoDisassembleLoading || dungeonNoStaminaCostSaving}
                  onChange={handleDungeonNoStaminaCostEnabledChange}
                />
              </div>
            </Space>
          ) : null}

          {activeKey === 'security' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                账号安全
              </Typography.Title>
              <Typography.Text type="secondary" className="setting-rule-tip">
                修改完成后，新密码会立即生效。当前登录态不受影响，但后续重新登录需要使用新密码。
              </Typography.Text>

              <div className="setting-rule-card">
                <Form
                  form={changePasswordForm}
                  layout="vertical"
                  onFinish={(values) => {
                    void handleChangePassword(values);
                  }}
                  disabled={changePasswordSaving}
                  className="setting-password-form"
                >
                  <Form.Item
                    label="当前密码"
                    name="currentPassword"
                    rules={[{ required: true, message: '请输入当前密码' }]}
                  >
                    <Input.Password placeholder="请输入当前密码" />
                  </Form.Item>

                  <Form.Item
                    label="新密码"
                    name="newPassword"
                    dependencies={['currentPassword']}
                    rules={[
                      { required: true, message: '请输入新密码' },
                      { min: ACCOUNT_PASSWORD_MIN_LENGTH, message: ACCOUNT_PASSWORD_MIN_LENGTH_MESSAGE },
                      ({ getFieldValue }) => ({
                        validator: createDistinctPasswordValidator(
                          getFieldValue,
                          'currentPassword',
                          ACCOUNT_PASSWORD_SAME_AS_CURRENT_MESSAGE,
                        ),
                      }),
                    ]}
                  >
                    <Input.Password placeholder={`请输入至少 ${ACCOUNT_PASSWORD_MIN_LENGTH} 位新密码`} />
                  </Form.Item>

                  <Form.Item
                    label="确认新密码"
                    name="confirmPassword"
                    dependencies={['newPassword']}
                    rules={[
                      { required: true, message: '请确认新密码' },
                      ({ getFieldValue }) => ({
                        validator: createConfirmPasswordValidator(
                          getFieldValue,
                          'newPassword',
                          '两次输入的新密码不一致',
                        ),
                      }),
                    ]}
                  >
                    <Input.Password placeholder="请再次输入新密码" />
                  </Form.Item>

                  <div className="setting-password-actions">
                    <Button
                      onClick={() => changePasswordForm.resetFields()}
                      disabled={changePasswordSaving}
                    >
                      重置
                    </Button>
                    <Button type="primary" htmlType="submit" loading={changePasswordSaving}>
                      确认修改
                    </Button>
                  </div>
                </Form>
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
                每条规则独立生效。子类列表会随已选品类联动，避免配置到不属于该品类的子类。
              </Typography.Text>

              {autoDisassembleRules.map((rule, index) => {
                const normalizedCategories = normalizeAutoDisassembleCategoryList(rule.categories);
                const subCategoryOptions = buildAutoDisassembleSubCategoryOptionsByCategories(normalizedCategories);
                const hasLimitedCategories = normalizedCategories.length > 0;
                return (
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
                        onChange={(next) => {
                          const nextCategories = normalizeAutoDisassembleCategoryList(next);
                          handleUpdateAutoDisassembleRule(rule.id, {
                            categories: nextCategories,
                            subCategories: normalizeRuleSubCategoriesBySelectedCategories(nextCategories, rule.subCategories),
                            excludedSubCategories: normalizeRuleSubCategoriesBySelectedCategories(
                              nextCategories,
                              rule.excludedSubCategories,
                            ),
                          });
                        }}
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
                        options={subCategoryOptions}
                        onChange={(next) =>
                          handleUpdateAutoDisassembleRule(rule.id, {
                            subCategories: normalizeRuleSubCategoriesBySelectedCategories(rule.categories, next),
                          })
                        }
                        style={{ width: '100%' }}
                        placeholder={hasLimitedCategories ? '仅展示当前品类可选子类' : '未限制品类时展示全部子类'}
                      />
                    </div>

                    <div className="setting-row setting-row-column">
                      <Typography.Text>排除子类</Typography.Text>
                      <Select
                        mode="multiple"
                        value={rule.excludedSubCategories}
                        disabled={autoDisassembleLoading || autoDisassembleSaving}
                        options={subCategoryOptions}
                        onChange={(next) =>
                          handleUpdateAutoDisassembleRule(rule.id, {
                            excludedSubCategories: normalizeRuleSubCategoriesBySelectedCategories(rule.categories, next),
                          })
                        }
                        style={{ width: '100%' }}
                        placeholder={hasLimitedCategories ? '仅展示当前品类可选子类' : '未限制品类时展示全部子类'}
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
                        placeholder="如：丹,剑,残页"
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
                        placeholder="如：任务,钥匙"
                      />
                    </div>
                  </div>
                );
              })}

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
                兑换码
              </Typography.Title>
              {isMobile ? (
                <Space direction="vertical" size={8} className="setting-cdk-mobile">
                  <Input
                    value={cdk}
                    onChange={(e) => setCdk(e.target.value)}
                    placeholder="请输入兑换码"
                    disabled={cdkRedeeming}
                  />
                  <Button type="primary" onClick={() => void redeemCdk()} block loading={cdkRedeeming} disabled={cdkRedeeming}>
                    兑换
                  </Button>
                </Space>
              ) : (
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={cdk}
                    onChange={(e) => setCdk(e.target.value)}
                    placeholder="请输入兑换码"
                    disabled={cdkRedeeming}
                  />
                  <Button type="primary" onClick={() => void redeemCdk()} loading={cdkRedeeming} disabled={cdkRedeeming}>
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
