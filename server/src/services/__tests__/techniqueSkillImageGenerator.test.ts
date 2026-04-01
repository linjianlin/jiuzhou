import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  compressTechniqueSkillImageBuffer,
  generateTechniqueSkillIconMap,
  shouldBypassTechniqueSkillImageGeneration,
  TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE,
} from '../shared/techniqueSkillImageGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const restoreEnvValue = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

test('compressTechniqueSkillImageBuffer: 应统一压缩为受限尺寸的 webp', async () => {
  const original = await sharp({
    create: {
      width: 1024,
      height: 768,
      channels: 4,
      background: { r: 120, g: 80, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const compressed = await compressTechniqueSkillImageBuffer(original);
  assert.ok(compressed);
  assert.ok(compressed.length > 0);

  const metadata = await sharp(compressed).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE);
  assert.equal(metadata.height, 288);
});

test('shouldBypassTechniqueSkillImageGeneration: 仅 development 环境应跳过功法技能生图', () => {
  assert.equal(shouldBypassTechniqueSkillImageGeneration('development'), true);
  assert.equal(shouldBypassTechniqueSkillImageGeneration('production'), false);
  assert.equal(shouldBypassTechniqueSkillImageGeneration(undefined), false);
});

test('generateTechniqueSkillIconMap: development 环境下应直接跳过图片请求', async () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AI_TECHNIQUE_IMAGE_MODEL_URL: process.env.AI_TECHNIQUE_IMAGE_MODEL_URL,
    AI_TECHNIQUE_IMAGE_MODEL_KEY: process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY,
  };
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  process.env.NODE_ENV = 'development';
  process.env.AI_TECHNIQUE_IMAGE_MODEL_URL = 'https://dashscope.test';
  process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY = 'test-key';

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('development 环境不应发起功法技能生图请求');
  };

  try {
    const iconMap = await generateTechniqueSkillIconMap([
      {
        skillId: 'skill-dev',
        techniqueName: '太虚引雷诀',
        techniqueType: 'spell',
        techniqueQuality: 'legendary',
        techniqueElement: 'thunder',
        skillName: '雷息一式',
        skillDescription: '落雷轰击前方敌人。',
        skillEffects: [],
      },
    ]);

    assert.equal(iconMap.size, 0);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvValue('NODE_ENV', originalEnv.NODE_ENV);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MODEL_URL', originalEnv.AI_TECHNIQUE_IMAGE_MODEL_URL);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MODEL_KEY', originalEnv.AI_TECHNIQUE_IMAGE_MODEL_KEY);
  }
});

test('generateTechniqueSkillIconMap: 批量生图应将并发峰值固定为 3', async () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AI_TECHNIQUE_IMAGE_MODEL_URL: process.env.AI_TECHNIQUE_IMAGE_MODEL_URL,
    AI_TECHNIQUE_IMAGE_MODEL_KEY: process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY,
    AI_TECHNIQUE_IMAGE_MODEL_NAME: process.env.AI_TECHNIQUE_IMAGE_MODEL_NAME,
    AI_TECHNIQUE_IMAGE_PROVIDER: process.env.AI_TECHNIQUE_IMAGE_PROVIDER,
    AI_TECHNIQUE_IMAGE_MAX_SKILLS: process.env.AI_TECHNIQUE_IMAGE_MAX_SKILLS,
  };
  const originalFetch = globalThis.fetch;
  const generatedLocalPaths: string[] = [];

  process.env.NODE_ENV = 'test';
  process.env.AI_TECHNIQUE_IMAGE_MODEL_URL = 'https://dashscope.test';
  process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY = 'test-key';
  process.env.AI_TECHNIQUE_IMAGE_MODEL_NAME = 'qwen-image-2.0';
  process.env.AI_TECHNIQUE_IMAGE_PROVIDER = 'dashscope';
  process.env.AI_TECHNIQUE_IMAGE_MAX_SKILLS = '4';

  const imageB64 = (await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 255, g: 180, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer())
    .toString('base64');

  let inFlight = 0;
  let peakConcurrency = 0;

  globalThis.fetch = async (_input, _init) => {
    inFlight += 1;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
    return new Response(
      JSON.stringify({
        output: {
          results: [{
            b64_image: imageB64,
          }],
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  };

  try {
    const iconMap = await generateTechniqueSkillIconMap([
      {
        skillId: 'skill-1',
        techniqueName: '太虚引雷诀',
        techniqueType: 'spell',
        techniqueQuality: 'legendary',
        techniqueElement: 'thunder',
        skillName: '雷息一式',
        skillDescription: '落雷轰击前方敌人。',
        skillEffects: [],
      },
      {
        skillId: 'skill-2',
        techniqueName: '太虚引雷诀',
        techniqueType: 'spell',
        techniqueQuality: 'legendary',
        techniqueElement: 'thunder',
        skillName: '雷息二式',
        skillDescription: '落雷轰击前方敌人。',
        skillEffects: [],
      },
      {
        skillId: 'skill-3',
        techniqueName: '太虚引雷诀',
        techniqueType: 'spell',
        techniqueQuality: 'legendary',
        techniqueElement: 'thunder',
        skillName: '雷息三式',
        skillDescription: '落雷轰击前方敌人。',
        skillEffects: [],
      },
      {
        skillId: 'skill-4',
        techniqueName: '太虚引雷诀',
        techniqueType: 'spell',
        techniqueQuality: 'legendary',
        techniqueElement: 'thunder',
        skillName: '雷息四式',
        skillDescription: '落雷轰击前方敌人。',
        skillEffects: [],
      },
    ]);

    generatedLocalPaths.push(...Array.from(iconMap.values()));
    assert.equal(iconMap.size, 4);
    assert.equal(peakConcurrency, 3);
    for (const icon of iconMap.values()) {
      assert.match(icon, /^\/uploads\/techniques\/tech-skill-/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvValue('NODE_ENV', originalEnv.NODE_ENV);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MODEL_URL', originalEnv.AI_TECHNIQUE_IMAGE_MODEL_URL);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MODEL_KEY', originalEnv.AI_TECHNIQUE_IMAGE_MODEL_KEY);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MODEL_NAME', originalEnv.AI_TECHNIQUE_IMAGE_MODEL_NAME);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_PROVIDER', originalEnv.AI_TECHNIQUE_IMAGE_PROVIDER);
    restoreEnvValue('AI_TECHNIQUE_IMAGE_MAX_SKILLS', originalEnv.AI_TECHNIQUE_IMAGE_MAX_SKILLS);

    await Promise.all(
      generatedLocalPaths.map(async (iconPath) => {
        const absolutePath = path.resolve(__dirname, '../../..', `.${iconPath}`);
        await fs.rm(absolutePath, { force: true });
      }),
    );
  }
});
