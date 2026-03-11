# 伙伴下阵 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为伙伴系统增加“下阵”能力，让角色可以不携带伙伴战斗，并让新获得伙伴在无出战伙伴时默认保持未出战。

**Architecture:** 后端复用单一的伙伴出战状态共享模块，同时支持“切到指定伙伴出战”和“清空出战伙伴”；前端继续以总览接口为单一数据源，在当前出战伙伴上展示“下阵”动作，并在 `activePartnerId` 为空时保持正常展示首个伙伴详情。

**Tech Stack:** TypeScript, React, Ant Design, Express, PostgreSQL

---

### Task 1: 先补失败测试锁定目标行为

**Files:**
- Modify: `server/src/services/__tests__/partnerActivation.test.ts`
- Create: `client/src/pages/Game/modules/__tests__/partnerPanelAction.test.ts`

**Step 1: 写后端共享出战状态测试**

- 断言共享入口在“切换到指定伙伴”时，仍然保持先清空旧出战再激活目标伙伴的 SQL 顺序。
- 断言共享入口在“清空出战伙伴”时，只执行一次 `SET is_active = FALSE` 更新。

**Step 2: 写前端伙伴操作文案测试**

- 断言未出战伙伴显示“设为出战”。
- 断言当前出战伙伴显示“下阵”。
- 断言 `activePartnerId = null` 时，仍能从伙伴列表中选中首个伙伴展示详情。

**Step 3: 运行局部测试确认先失败**

- Run: `pnpm --filter ./server test:local -- partnerActivation.test.ts`
- Expected: FAIL，提示缺少“清空出战伙伴”共享能力或测试断言不满足。

### Task 2: 实现后端共享出战状态与下阵接口

**Files:**
- Modify: `server/src/services/shared/partnerActivation.ts`
- Modify: `server/src/services/partnerService.ts`
- Modify: `server/src/routes/partnerRoutes.ts`

**Step 1: 扩展共享出战状态模块**

- 把“清空当前出战伙伴”抽成共享能力。
- 让“激活指定伙伴”复用同一入口，而不是继续单独维护两段 SQL。

**Step 2: 新增伙伴下阵服务**

- 在 `partnerService` 中新增 `dismiss(characterId)`。
- 返回 `activePartnerId: null` 与最新伙伴详情或必要状态。
- 保持幂等：无出战伙伴时也返回成功。

**Step 3: 新增下阵路由**

- 增加新的 `POST /partner/dismiss` 路由。
- 不接收 `partnerId`，直接基于当前角色执行下阵。

**Step 4: 调整新伙伴默认出战规则**

- 修改 `createPartnerInstanceFromDefinition`，让新获得伙伴默认 `is_active = false`。
- 保留伙伴实例创建的其他逻辑与唯一入口不变。

### Task 3: 改造前端伙伴弹窗交互

**Files:**
- Modify: `client/src/services/api/partner.ts`
- Modify: `client/src/pages/Game/modules/PartnerModal/index.tsx`

**Step 1: 扩展伙伴 API**

- 新增 `dismissPartner()` 请求函数。
- 调整响应类型以接受 `activePartnerId: number | null`。

**Step 2: 复用现有刷新链路改造按钮**

- 当前出战伙伴按钮文案改为“下阵”。
- 未出战伙伴继续显示“设为出战”。
- 写操作后统一调用总览刷新，不手工改局部状态。

**Step 3: 处理无出战伙伴的展示回退**

- 保持 `selectedPartnerId` 在 `activePartnerId = null` 时回退到首个伙伴。
- 保证列表标签、详情标签与按钮状态都跟随总览刷新结果。

### Task 4: 回归校验与构建

**Files:**
- Modify: 如实现中受影响文件

**Step 1: 运行新增局部测试**

- Run: `pnpm --filter ./server test:local -- partnerActivation.test.ts`
- Run: `pnpm --filter ./client exec vitest run client/src/pages/Game/modules/__tests__/partnerPanelAction.test.ts`

**Step 2: 运行 TypeScript 构建校验**

- Run: `tsc -b`

**Step 3: 汇总结果**

- 说明为消除重复而复用的共享出战状态模块。
- 报告测试结果与 `tsc -b` 结果。
