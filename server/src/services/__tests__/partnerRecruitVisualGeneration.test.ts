/**
 * 伙伴招募视觉资源并发执行测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴头像生成与伙伴天生功法生成会在同一入口内并发启动，避免后续改回串行等待。
 * 2. 做什么：验证头像入参映射仍然来自伙伴草稿本身，保证 service 不会再散落重复字段拼装。
 * 3. 不做什么：不请求真实模型、不访问数据库，也不覆盖功法 candidate 生成细节。
 *
 * 输入/输出：
 * - 输入：一份固定伙伴草稿、伙伴定义 ID，以及注入的假头像/功法生成依赖。
 * - 输出：并发执行结果 `{ techniques, avatarUrl }`。
 *
 * 数据流/状态流：
 * test draft -> executePartnerRecruitVisualGeneration -> 假依赖记录启动时机 -> 断言并发启动与结果聚合。
 *
 * 关键边界条件与坑点：
 * 1. 这个测试关注“启动时机”而不是完成顺序；只要回到串行实现，`avatar-start` 就不会在首轮调用里出现。
 * 2. 头像入参必须来自共享映射函数；否则 service 里很容易再次手写一遍 name/quality/element 字段拼装。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executePartnerRecruitVisualGeneration,
  type GeneratedRecruitTechniqueDraft,
} from '../partnerRecruitService.js';
import {
  fillPartnerRecruitBaseAttrs,
  type PartnerRecruitDraft,
} from '../shared/partnerRecruitRules.js';

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const draft: PartnerRecruitDraft = {
  partner: {
    name: '青璃',
    description: '她自山涧灵雾中化形而出，执伞听泉，性情清冷却总在危局前先一步护住同伴。',
    quality: '玄',
    attributeElement: 'shui',
    role: '灵卫',
    combatStyle: 'magic',
    maxTechniqueSlots: 4,
    baseAttrs: fillPartnerRecruitBaseAttrs({
      max_qixue: 120,
      max_lingqi: 80,
      sudu: 18,
    }),
    levelAttrGains: fillPartnerRecruitBaseAttrs({
      max_qixue: 12,
      max_lingqi: 8,
      sudu: 2,
    }),
  },
  innateTechniques: [
    {
      name: '听泉护心诀',
      description: '借灵泉回音凝成水幕，为己方稳住气血并削弱来袭余劲。',
      kind: 'support',
      passiveKey: 'zhiliao',
      passiveValue: 8,
    },
  ],
};

const techniques: GeneratedRecruitTechniqueDraft[] = [
  {
    techniqueId: 'tech-partner-1',
    candidate: {
      technique: {
        name: '听泉护心诀',
        type: '辅修',
        quality: '玄',
        maxLayer: 4,
        requiredRealm: '凡人',
        attributeType: 'magic',
        attributeElement: 'shui',
        tags: [],
        description: '借灵泉之意护体。',
        longDesc: '借灵泉之意护体，护持灵台清明。',
      },
      skills: [
        {
          id: 'skill-1',
          name: '泉幕',
          description: '凝泉为幕，为己方恢复气血。',
          icon: '/uploads/techniques/skill-1.webp',
          sourceType: 'technique',
          costLingqi: 10,
          costLingqiRate: 0,
          costQixue: 0,
          costQixueRate: 0,
          cooldown: 1,
          targetType: 'all_ally',
          targetCount: 1,
          damageType: null,
          element: 'shui',
          effects: [],
          triggerType: 'active',
          aiPriority: 100,
          upgrades: [],
        },
      ],
      layers: [],
    },
  },
];

test('executePartnerRecruitVisualGeneration: 伙伴头像与天生功法应并发启动', async () => {
  const startEvents: string[] = [];
  const techniqueDeferred = createDeferred<GeneratedRecruitTechniqueDraft[]>();
  const avatarDeferred = createDeferred<string>();

  const executionPromise = executePartnerRecruitVisualGeneration(
    {
      characterId: 1001,
      generationId: 'partner-recruit-test',
      draft,
      partnerDefId: 'partner-gen-test',
    },
    {
      generateTechniques: async (params) => {
        startEvents.push(`tech:${params.generationId}`);
        return techniqueDeferred.promise;
      },
      generateAvatar: async (input) => {
        startEvents.push(`avatar:${input.partnerId}:${input.name}:${input.element}`);
        return avatarDeferred.promise;
      },
    },
  );

  assert.deepEqual(startEvents, [
    'tech:partner-recruit-test',
    'avatar:partner-gen-test:青璃:shui',
  ]);

  avatarDeferred.resolve('/uploads/partners/partner-gen-test.webp');
  techniqueDeferred.resolve(techniques);

  const result = await executionPromise;
  assert.deepEqual(result, {
    techniques,
    avatarUrl: '/uploads/partners/partner-gen-test.webp',
  });
});
