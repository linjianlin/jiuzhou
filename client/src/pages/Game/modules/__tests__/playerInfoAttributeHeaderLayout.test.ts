/**
 * PlayerInfo 基础属性头部布局回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定基础属性区使用专用双行头部类名，避免窄侧栏里继续把标题和档位控制硬挤在同一行。
 * 2. 做什么：验证样式层只在窄面板容器下为该专用头部切成纵向布局，确保大屏宽侧栏仍保持单行。
 * 3. 不做什么：不渲染真实组件，也不覆盖按钮交互逻辑，只验证源码里的布局契约。
 *
 * 输入/输出：
 * - 输入：PlayerInfo TSX 与对应 SCSS 源码文本。
 * - 输出：是否包含专用头部类名和对应布局声明。
 *
 * 数据流/状态流：
 * PlayerInfo 基础属性 JSX -> 专用头部类名 -> index.scss 容器查询布局规则。
 *
 * 关键边界条件与坑点：
 * 1. 问题发生在窄侧栏桌面宽度，不是单纯手机断点；因此测试要锁定容器查询，避免以后又退回成只在 `max-width: 768px` 里修。
 * 2. 这里只验证结构契约，不替代真实视觉回归；如果未来头部类名变更，样式和 JSX 必须一起改。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const playerInfoPath = resolve(process.cwd(), 'client/src/pages/Game/modules/PlayerInfo/index.tsx');
const playerInfoStylePath = resolve(process.cwd(), 'client/src/pages/Game/modules/PlayerInfo/index.scss');

describe('PlayerInfo 基础属性头部布局', () => {
  it('基础属性区应使用专用双行头部类名', () => {
    const source = readFileSync(playerInfoPath, 'utf8');

    expect(source).toContain('attr-section-header attr-section-header--point-control');
  });

  it('专用头部类应仅在窄容器下切成纵向布局', () => {
    const source = readFileSync(playerInfoStylePath, 'utf8');

    expect(source).toContain('container-type: inline-size;');
    expect(source).toContain('@container (max-width: 280px)');
    expect(source).toContain('.attr-section-header--point-control');
    expect(source).toContain('flex-direction: column;');
    expect(source).toContain('.attr-section-header--point-control .attr-section-sub--point-control');
  });
});
