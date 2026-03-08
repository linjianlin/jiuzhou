# 功法生成 Buff 约束实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 AI 功法生成的 BUFF/DEBUFF 约束直接复用现有预定义技能与怪物效果数据，并在服务端校验阶段拦截非法效果。

**Architecture:** 以 `techniqueGenerationConstraints` 为单一入口，集中读取静态配置中的结构化效果，提炼允许的 `buffKind`、`attrKey`、`buffKey`，再把这份动态约束同时提供给 prompt 和生成结果校验。服务端保持运行时支持能力为上限，避免提示词、校验、战斗执行三处定义漂移。

**Tech Stack:** TypeScript、Node.js、静态 JSON seeds、现有 battle/shared/service 模块

---

### Task 1: 梳理可复用数据源

**Files:**
- Modify: `server/src/services/shared/techniqueGenerationConstraints.ts`
- Reference: `server/src/services/staticConfigLoader.ts`
- Reference: `server/src/battle/utils/buffSpec.ts`

**Step 1:** 读取 `skill_def.json` 与 `monster_def.json` 的结构化效果字段来源。

**Step 2:** 明确运行时已支持的 `buffKind/applyType/attrKey` 规则边界。

**Step 3:** 设计共享提炼函数，避免 prompt 与校验各自扫描一遍数据。

### Task 2: 接入动态 prompt 约束

**Files:**
- Modify: `server/src/services/shared/techniqueGenerationConstraints.ts`

**Step 1:** 新增动态允许集合导出。

**Step 2:** 用动态集合替换 prompt 中手写的 buff 约束内容。

**Step 3:** 保留必要的结构说明，但不再维护第二套硬编码白名单。

### Task 3: 补齐服务端校验

**Files:**
- Modify: `server/src/services/techniqueGenerationService.ts`
- Modify: `server/src/services/shared/techniqueGenerationConstraints.ts`

**Step 1:** 在共享模块暴露 `buff/debuff` 效果校验函数。

**Step 2:** 在 AI 结果校验链路中调用该函数，非法效果直接返回 `GENERATOR_INVALID`。

**Step 3:** 确保未知 `buffKind`、非法 `attrKey`、未收录 `buffKey` 不再漏进草稿。

### Task 4: 验证

**Files:**
- Verify: `server/src/services/shared/techniqueGenerationConstraints.ts`
- Verify: `server/src/services/techniqueGenerationService.ts`

**Step 1:** 运行 `tsc -b`。

**Step 2:** 记录通过或失败结果，并整理变更说明。
