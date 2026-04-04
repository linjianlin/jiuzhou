/**
 * 应用版本共享规则测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定版本清单路径归一化、版本元数据清洗和更新判定逻辑，确保构建层与运行时层共用同一套规则。
 * 2. 做什么：保证页头展示与根部更新提示读取的是同一种版本字段，避免再次出现硬编码版本漂移。
 * 3. 不做什么：不发真实请求、不依赖 Vite 构建，也不渲染 React 组件。
 *
 * 输入 / 输出：
 * - 输入：原始版本元数据对象与版本清单路径。
 * - 输出：标准化路径、标准化版本元数据和版本变化判断结果。
 *
 * 数据流 / 状态流：
 * 测试数据 -> `appVersionShared.ts` 纯函数
 * -> 输出标准化结果
 * -> 断言更新检测与版本展示共用的基础规则。
 *
 * 关键边界条件与坑点：
 * 1. 清单路径必须强制转成绝对相对路径，否则 CDN 基址拼接会出现不一致。
 * 2. 版本变化判定只能基于稳定版本指纹，不能把构建时间变化误当成唯一依据。
 */

import { describe, expect, it } from 'vitest';
import {
  hasAppVersionChanged,
  normalizeAppVersionMeta,
  resolveAppVersionManifestPath,
} from '../appVersionShared';

describe('appVersionShared', () => {
  it('应把版本清单路径归一化为以斜杠开头的路径', () => {
    expect(resolveAppVersionManifestPath('version.json')).toBe('/version.json');
    expect(resolveAppVersionManifestPath('/version.json')).toBe('/version.json');
  });

  it('应清洗版本元数据中的首尾空白字符', () => {
    expect(
      normalizeAppVersionMeta({
        version: ' 20260405093015 ',
        builtAt: ' 2026-04-05T09:30:15+08:00 ',
      }),
    ).toEqual({
      version: '20260405093015',
      builtAt: '2026-04-05T09:30:15+08:00',
    });
  });

  it('应在版本指纹变化时返回需要刷新', () => {
    expect(
      hasAppVersionChanged(
        { version: '20260405093015', builtAt: '2026-04-05T09:30:15+08:00' },
        { version: '20260405101530', builtAt: '2026-04-05T10:15:30+08:00' },
      ),
    ).toBe(true);
  });

  it('应在版本指纹一致时保持不刷新', () => {
    expect(
      hasAppVersionChanged(
        { version: '20260405093015', builtAt: '2026-04-05T09:30:15+08:00' },
        { version: '20260405093015', builtAt: '2026-04-05T10:15:30+08:00' },
      ),
    ).toBe(false);
  });
});
