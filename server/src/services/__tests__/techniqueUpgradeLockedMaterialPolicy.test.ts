import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const assertLockedMaterialCheckedBeforeResourceConsume = (source: string, fileLabel: string): void => {
  const atomicConsumeIndex = source.indexOf('consumeCharacterStoredResourcesAndMaterialsAtomically(');

  assert.notEqual(atomicConsumeIndex, -1, `${fileLabel} 应复用共享原子扣费入口`);
  assert.equal(source.indexOf('validateMaterialConsumeRequirements('), -1, `${fileLabel} 不应在服务层手写分步校验`);
  assert.equal(source.indexOf('consumeMaterialByDefId('), -1, `${fileLabel} 不应在服务层手写分步扣材料`);
  assert.equal(source.indexOf('consumeCharacterStoredResources('), -1, `${fileLabel} 不应在服务层手写分步扣资源`);
};

test('characterTechniqueService: 锁定材料时不得先扣角色资源', () => {
  const source = readSource('../characterTechniqueService.ts');
  assertLockedMaterialCheckedBeforeResourceConsume(source, 'characterTechniqueService');
});

test('partnerService: 锁定材料时不得先扣角色资源', () => {
  const source = readSource('../partnerService.ts');
  assertLockedMaterialCheckedBeforeResourceConsume(source, 'partnerService');
});
