import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWanderAiEpisodeResolutionPromptRuleSet,
  buildWanderAiEpisodeResolutionResponseSchema,
  buildWanderAiEpisodeResolutionSystemMessage,
  buildWanderAiEpisodeResolutionUserPayload,
  buildWanderAiEpisodeSetupPromptRuleSet,
  buildWanderAiEpisodeSetupSystemMessage,
  buildWanderAiEpisodeSetupUserPayload,
  validateWanderAiEpisodeResolutionContent,
  validateWanderAiEpisodeSetupContent,
} from '../wander/ai.js';

test('buildWanderAiEpisodeSetupPromptRuleSet: 应显式包含幕次生成的主题、引子、标题与选项约束', () => {
  const ruleSet = buildWanderAiEpisodeSetupPromptRuleSet(false);

  assert.equal(ruleSet.outputRules.storyThemeLengthRange, '2-24');
  assert.equal(ruleSet.outputRules.storyPremiseLengthRange, '8-120');
  assert.equal(ruleSet.outputRules.episodeTitleLengthRange, '2-24');
  assert.equal(ruleSet.outputRules.optionCount, 3);
  assert.equal(ruleSet.outputRules.openingLengthRange, '80-420');
  assert.match(ruleSet.outputRules.openingStyleRule, /禁止提前替玩家做选择/u);
  assert.match(ruleSet.outputRules.endingSceneRule, /不能提前把整条故事写完/u);
});

test('buildWanderAiEpisodeSetupSystemMessage: 终幕待选幕次必须禁止提前写尾声与称号', () => {
  const systemMessage = buildWanderAiEpisodeSetupSystemMessage(true);

  assert.match(systemMessage, /本阶段只负责生成待玩家选择的幕次/u);
  assert.match(systemMessage, /终幕抉择幕/u);
  assert.match(systemMessage, /不能提前写玩家选择后的尾声、结局类型、称号名/u);
});

test('buildWanderAiEpisodeSetupUserPayload: 不应再把 mainQuestName 透传给模型，且应暴露终幕待选标记', () => {
  const payload = buildWanderAiEpisodeSetupUserPayload({
    nickname: '测试角色',
    realm: '炼气期',
    hasTeam: false,
    storyLocation: {
      region: '东洲',
      mapId: 'map-qingyun-outskirts',
      mapName: '青云村外',
      areaId: 'room-south-forest',
      areaName: '南侧密林',
      fullName: '东洲·青云村外·南侧密林',
    },
    activeTheme: null,
    activePremise: null,
    storySummary: null,
    nextEpisodeIndex: 5,
    maxEpisodeIndex: 5,
    isEndingEpisode: true,
    previousEpisodes: [],
  }, 123456);

  assert.equal(payload.player.nickname, '测试角色');
  assert.equal(payload.story.isEndingEpisode, true);
  assert.equal('mainQuestName' in payload.player, false);
  assert.equal('mapName' in payload.player, false);
  assert.equal(payload.storyLocation.fullName, '东洲·青云村外·南侧密林');
});

test('buildWanderAiEpisodeSetupUserPayload: 前文上下文必须包含完整幕次正文、已选项与结果段', () => {
  const payload = buildWanderAiEpisodeSetupUserPayload({
    nickname: '测试角色',
    realm: '炼气期',
    hasTeam: false,
    storyLocation: {
      region: '东洲',
      mapId: 'map-qingyun-outskirts',
      mapName: '青云村外',
      areaId: 'room-south-forest',
      areaName: '南侧密林',
      fullName: '东洲·青云村外·南侧密林',
    },
    activeTheme: '雨夜借灯',
    activePremise: '你循着残留血迹误入谷口深处，今夜的异物并非寻常山兽。',
    storySummary: '你已被卷进更深的风波。',
    nextEpisodeIndex: 2,
    maxEpisodeIndex: 5,
    isEndingEpisode: false,
    previousEpisodes: [{
      dayIndex: 1,
      locationName: '东洲·青云村外·南侧密林',
      title: '桥下窥影',
      opening: '夜雨压桥，河雾顺着石栏缓缓爬起，你在破庙檐下收住衣角，见对岸灯影摇成一线。',
      chosenOptionText: '先借檐避雨，再试探来意',
      summary: '你借灯试探来意后稳住桥上气机，却也惊动了桥下更深的暗潮。',
      isEnding: false,
    }],
  }, 123456);

  assert.equal(payload.story.previousEpisodes[0]?.opening, '夜雨压桥，河雾顺着石栏缓缓爬起，你在破庙檐下收住衣角，见对岸灯影摇成一线。');
  assert.equal(payload.story.previousEpisodes[0]?.chosenOptionText, '先借檐避雨，再试探来意');
  assert.equal(payload.story.previousEpisodes[0]?.summary, '你借灯试探来意后稳住桥上气机，却也惊动了桥下更深的暗潮。');
  assert.equal(payload.story.previousEpisodes[0]?.isEnding, false);
  assert.equal(payload.story.previousEpisodes[0]?.locationName, '东洲·青云村外·南侧密林');
});

test('validateWanderAiEpisodeSetupContent: 合法待选幕次必须通过', () => {
  const validation = validateWanderAiEpisodeSetupContent(JSON.stringify({
    storyTheme: '雨夜借灯',
    storyPremise: '你循着残留血迹误入谷口深处，才觉今夜盘踞此地的异物并非寻常山兽。',
    episodeTitle: '桥下窥影',
    opening: '夜雨压桥，河雾顺着石栏缓缓爬起，你在破庙檐下收住衣角，见对岸灯影摇成一线。那人披旧蓑衣提灯不前不后，只隔雨幕望来，像在等谁认出他的来意。桥下水声忽然沉了一拍，像有什么东西正贴着桥墩缓缓游过。你屏住气息，才发觉这场相遇并非偶然，来客与暗潮都在试探你会先看向哪一边。',
    optionTexts: ['先借檐避雨，再试探来意', '绕到桥下暗查灵息', '收敛气机，静观其变'],
  }));

  if (!validation.success) {
    throw new Error(validation.reason);
  }

  assert.equal(validation.data.optionTexts.length, 3);
});

test('buildWanderAiEpisodeResolutionPromptRuleSet: 终幕结算必须显式暴露称号颜色与属性白名单约束', () => {
  const ruleSet = buildWanderAiEpisodeResolutionPromptRuleSet('must_end');

  assert.equal(ruleSet.outputRules.summaryLengthRange, '20-160');
  assert.equal(ruleSet.outputRules.rewardTitleColorPattern, '#RRGGBB');
  assert.equal(ruleSet.outputRules.rewardTitleEffectCountRange, '1-5');
  assert.match(ruleSet.outputRules.rewardTitleEffectGuide, /max_qixue|wugong|fagong/u);
  assert.equal(ruleSet.outputRules.rewardTitleEffectValueMaxMap.max_qixue, 240);
  assert.equal(ruleSet.outputRules.rewardTitleEffectValueMaxMap.wugong, 60);
});

test('buildWanderAiEpisodeResolutionSystemMessage: 非终幕结算必须强调称号字段清空', () => {
  const systemMessage = buildWanderAiEpisodeResolutionSystemMessage('must_continue');

  assert.match(systemMessage, /本阶段只负责根据玩家已经选定的选项/u);
  assert.match(systemMessage, /非终幕结算必须返回 endingType=none/u);
});

test('buildWanderAiEpisodeResolutionResponseSchema: 终幕结算 schema 必须要求合法颜色与属性数组', () => {
  const schema = buildWanderAiEpisodeResolutionResponseSchema('must_end');

  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.rewardTitleColor.type, 'string');
  assert.equal(schema.properties.rewardTitleEffects.type, 'array');
  if (schema.properties.rewardTitleColor.type !== 'string' || schema.properties.rewardTitleEffects.type !== 'array') {
    throw new Error('云游终幕结算 schema 字段类型必须满足字符串/数组约束');
  }

  assert.equal(schema.properties.rewardTitleColor.pattern, '^#[0-9a-fA-F]{6}$');
  assert.equal(schema.properties.rewardTitleEffects.minItems, 1);
  assert.equal(schema.properties.rewardTitleEffects.maxItems, 5);
});

test('buildWanderAiEpisodeResolutionUserPayload: 应透传本幕选择与终幕结算模式', () => {
  const payload = buildWanderAiEpisodeResolutionUserPayload({
    nickname: '测试角色',
    realm: '炼气期',
    hasTeam: false,
    storyLocation: {
      region: '东洲',
      mapId: 'map-fallen-ruins',
      mapName: '断碑遗迹',
      areaId: 'room-stone-bridge',
      areaName: '残桥石道',
      fullName: '东洲·断碑遗迹·残桥石道',
    },
    activeTheme: '雨夜借灯',
    activePremise: '断桥与旧祠都在等你作出最后抉择。',
    storySummary: '上一幕的试探已经惊动双方。',
    currentEpisodeIndex: 5,
    maxEpisodeIndex: 5,
    currentEpisodeTitle: '断桥定局',
    currentEpisodeOpening: '桥身欲裂，旧祠阴火映得河面幽蓝，最终抉择已压到你面前。',
    chosenOptionText: '先斩来客，再回身镇桥',
    isEndingEpisode: true,
    previousEpisodes: [{
      dayIndex: 4,
      locationName: '东洲·断碑遗迹·残桥石道',
      title: '灯底问潮',
      opening: '旧祠灯火摇得河面忽明忽暗，桥下暗潮已沿石桩缠到你脚边。',
      chosenOptionText: '先稳灯火，再听来客开口',
      summary: '你先稳住旧祠灯火，逼得来客先暴露底细，也让桥下暗潮彻底失去藏身余地。',
      isEnding: false,
    }],
  }, 123456);

  assert.equal(payload.story.chosenOptionText, '先斩来客，再回身镇桥');
  assert.equal(payload.story.resolutionMode, 'must_end');
  assert.equal(payload.storyLocation.fullName, '东洲·断碑遗迹·残桥石道');
  assert.equal(payload.story.previousEpisodes[0]?.opening, '旧祠灯火摇得河面忽明忽暗，桥下暗潮已沿石桩缠到你脚边。');
  assert.equal(payload.story.previousEpisodes[0]?.chosenOptionText, '先稳灯火，再听来客开口');
});

test('validateWanderAiEpisodeResolutionContent: 非终幕返回空称号字段与空属性数组时必须通过', () => {
  const validation = validateWanderAiEpisodeResolutionContent(JSON.stringify({
    summary: '你先借檐避雨稳住桥上局势，逼得来客露出口风，却也惊动了桥下更深的暗潮。',
    endingType: 'none',
    rewardTitleName: '',
    rewardTitleDesc: '',
    rewardTitleColor: '',
    rewardTitleEffects: [],
  }), 'must_continue');

  if (validation.success) {
    assert.deepEqual(validation.data.rewardTitleEffects, {});
    return;
  }
  throw new Error(validation.reason);
});

test('validateWanderAiEpisodeResolutionContent: 终幕百分比称号属性必须使用小数比率口径', () => {
  const validation = validateWanderAiEpisodeResolutionContent(JSON.stringify({
    summary: '你先斩断来客借桥引动的邪法，再回身镇住桥下暗潮，雨夜由此收束成一段险极而成的缘法。',
    endingType: 'good',
    rewardTitleName: '断桥镇潮',
    rewardTitleDesc: '断桥一战后，余威仍镇河潮。',
    rewardTitleColor: '#faad14',
    rewardTitleEffects: [
      { key: 'wugong', value: 60 },
      { key: 'baoji', value: 0.03 },
      { key: 'kangbao', value: 0.02 },
    ],
  }), 'must_end');

  if (!validation.success) {
    throw new Error(validation.reason);
  }

  assert.deepEqual(validation.data.rewardTitleEffects, {
    wugong: 60,
    baoji: 0.03,
    kangbao: 0.02,
  });
});

test('validateWanderAiEpisodeResolutionContent: 终幕百分比称号属性若写成整数百分数必须拒绝', () => {
  const validation = validateWanderAiEpisodeResolutionContent(JSON.stringify({
    summary: '你先斩断来客借桥引动的邪法，再回身镇住桥下暗潮，雨夜由此收束成一段险极而成的缘法。',
    endingType: 'good',
    rewardTitleName: '断桥镇潮',
    rewardTitleDesc: '断桥一战后，余威仍镇河潮。',
    rewardTitleColor: '#faad14',
    rewardTitleEffects: [
      { key: 'wugong', value: 60 },
      { key: 'baoji', value: 15 },
    ],
  }), 'must_end');

  assert.equal(validation.success, false);
  if (validation.success) {
    throw new Error('整数百分数字段不应通过云游称号校验');
  }
});

test('validateWanderAiEpisodeResolutionContent: 高价值固定值属性必须命中更严格的专属上限', () => {
  const validation = validateWanderAiEpisodeResolutionContent(JSON.stringify({
    summary: '你正面压住荒台残兵的最后一道剑压，旧宗荒台的局势终于在你手中定住，但代价也清晰刻进气机深处。',
    endingType: 'good',
    rewardTitleName: '荒台定锋',
    rewardTitleDesc: '荒台旧锋未灭，余势仍可镇敌。',
    rewardTitleColor: '#faad14',
    rewardTitleEffects: [
      { key: 'wugong', value: 61 },
      { key: 'max_qixue', value: 240 },
    ],
  }), 'must_end');

  assert.equal(validation.success, false);
  if (validation.success) {
    throw new Error('物攻超出专属上限时不应通过云游称号校验');
  }
});
