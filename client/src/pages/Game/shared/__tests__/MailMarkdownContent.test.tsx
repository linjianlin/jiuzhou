/**
 * 邮件 Markdown 渲染静态回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定共享邮件 Markdown 组件对常用语法的静态渲染结构，确保邮件详情页不会再把标题、列表与引用压成纯文本。
 * 2. 做什么：验证原始 HTML 会被当作普通文本处理，避免邮件正文渲染链路放开不安全 HTML。
 * 3. 不做什么：不验证邮件弹窗交互、不覆盖附件区域，也不连接任何接口。
 *
 * 输入/输出：
 * - 输入：Markdown 字符串。
 * - 输出：`renderToStaticMarkup` 生成的安全 HTML 结构。
 *
 * 数据流/状态流：
 * 邮件正文 Markdown -> `MailMarkdownContent` -> 静态 HTML 字符串断言。
 *
 * 关键边界条件与坑点：
 * 1. Markdown 渲染只支持受控子集，测试必须覆盖标题、列表、引用与行内强调，防止后续退化成纯文本。
 * 2. 原始 HTML 标签必须保持转义输出，不能被解析成真实 DOM。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MailMarkdownContent from '../MailMarkdownContent';

describe('MailMarkdownContent', () => {
  it('应渲染标题、列表、引用与行内 Markdown 结构', () => {
    const html = renderToStaticMarkup(
      <MailMarkdownContent
        content={[
          '## 补偿说明',
          '',
          '针对近期天级伙伴属性出现比预期低的情况，现发放 **归元洗髓露** 补偿。',
          '',
          '- 附件：`归元洗髓露 ×2`',
          '- 记录数：**2 条**',
          '',
          '1. 2026-03-30 12:34:56 招募 **赤霄**',
          '2. 2026-03-31 08:00:00 招募 **青岚**',
          '',
          '> 请及时查收附件。',
        ].join('\n')}
      />,
    );

    expect(html).toContain('<h2 class="mail-markdown-heading mail-markdown-heading-level-2">补偿说明</h2>');
    expect(html).toContain('<strong>归元洗髓露</strong>');
    expect(html).toContain('<ul class="mail-markdown-list mail-markdown-list-unordered">');
    expect(html).toContain('<ol class="mail-markdown-list mail-markdown-list-ordered">');
    expect(html).toContain('<code class="mail-markdown-code">归元洗髓露 ×2</code>');
    expect(html).toContain('<blockquote class="mail-markdown-blockquote">');
  });

  it('不应解释原始 HTML 标签', () => {
    const html = renderToStaticMarkup(
      <MailMarkdownContent content={'正文<script>alert(1)</script>'} />,
    );

    expect(html).toContain('正文&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
