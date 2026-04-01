/**
 * 邮件 Markdown 内容渲染组件
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析并渲染邮件正文需要的安全 Markdown 子集，供邮件详情等文本展示入口复用。
 * 2. 做什么：把标题、列表、引用、强调、链接等常用展示结构收口到单一组件，避免页面内重复手写换行和列表逻辑。
 * 3. 不做什么：不解析内嵌 HTML、不处理附件展示，也不承担任何邮件业务判断。
 *
 * 输入/输出：
 * - 输入：Markdown 文本内容与可选样式类名。
 * - 输出：可直接挂到页面中的 React 渲染节点树。
 *
 * 数据流/状态流：
 * 邮件正文字符串 -> 本组件解析成块级结构与行内节点 -> 邮件详情页直接渲染。
 *
 * 复用设计说明：
 * - Markdown 语法解析是后续系统邮件的高频变化点，集中在这里后，邮件详情页和未来其他正文面板都复用同一套规则。
 * - 块级与行内解析都在组件内部纯函数中完成，避免 MailModal、补偿邮件、公告邮件各自散落正则和 JSX 分支。
 *
 * 关键边界条件与坑点：
 * 1. 原始 HTML 必须始终按普通文本输出，不能解释执行，因此这里只构造 React 节点，不使用 `dangerouslySetInnerHTML`。
 * 2. 当前只支持常用 Markdown 子集；遇到不支持的复杂语法时保持原样文本显示，不能强行扩展成不稳定解析。
 */
import { Fragment, useMemo, type ReactNode } from 'react';

import './MailMarkdownContent.scss';

type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'unordered_list'; items: string[] }
  | { type: 'ordered_list'; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'divider' };

interface MailMarkdownContentProps {
  content: string;
  className?: string;
}

const HEADING_RE = /^(#{1,4})\s+(.+)$/u;
const ORDERED_LIST_RE = /^\d+\.\s+(.+)$/u;
const UNORDERED_LIST_RE = /^[-*]\s+(.+)$/u;
const BLOCKQUOTE_RE = /^>\s?(.*)$/u;
const DIVIDER_RE = /^([-*_])(?:\s*\1){2,}\s*$/u;
const SAFE_LINK_RE = /^(https?:\/\/|mailto:)/iu;

const buildMailMarkdownRootClassName = (className?: string): string => {
  return className ? `mail-markdown-root ${className}` : 'mail-markdown-root';
};

const isMarkdownBlockStart = (line: string): boolean => {
  return HEADING_RE.test(line)
    || ORDERED_LIST_RE.test(line)
    || UNORDERED_LIST_RE.test(line)
    || BLOCKQUOTE_RE.test(line)
    || DIVIDER_RE.test(line);
};

const parseMarkdownBlocks = (content: string): MarkdownBlock[] => {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      index += 1;
      continue;
    }

    const headingMatch = trimmedLine.match(HEADING_RE);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1].length) as 1 | 2 | 3 | 4;
      blocks.push({
        type: 'heading',
        level,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (DIVIDER_RE.test(trimmedLine)) {
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(trimmedLine)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const currentLine = (lines[index] ?? '').trim();
        const match = currentLine.match(BLOCKQUOTE_RE);
        if (!match) break;
        quoteLines.push(match[1]);
        index += 1;
      }
      blocks.push({
        type: 'blockquote',
        text: quoteLines.join('\n').trim(),
      });
      continue;
    }

    if (UNORDERED_LIST_RE.test(trimmedLine)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = (lines[index] ?? '').trim();
        const match = currentLine.match(UNORDERED_LIST_RE);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: 'unordered_list', items });
      continue;
    }

    if (ORDERED_LIST_RE.test(trimmedLine)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = (lines[index] ?? '').trim();
        const match = currentLine.match(ORDERED_LIST_RE);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: 'ordered_list', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index] ?? '';
      const trimmedCurrentLine = currentLine.trim();
      if (!trimmedCurrentLine) {
        index += 1;
        break;
      }
      if (paragraphLines.length > 0 && isMarkdownBlockStart(trimmedCurrentLine)) {
        break;
      }
      paragraphLines.push(currentLine.trim());
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join('\n'),
    });
  }

  return blocks;
};

const renderInlineMarkdown = (content: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let index = 0;
  let tokenIndex = 0;

  const pushText = (text: string): void => {
    if (!text) return;
    nodes.push(text);
  };

  while (index < content.length) {
    if (content[index] === '\n') {
      nodes.push(<br key={`${keyPrefix}-br-${tokenIndex}`} />);
      tokenIndex += 1;
      index += 1;
      continue;
    }

    if (content.startsWith('**', index)) {
      const closingIndex = content.indexOf('**', index + 2);
      if (closingIndex > index + 2) {
        const innerContent = content.slice(index + 2, closingIndex);
        nodes.push(
          <strong key={`${keyPrefix}-strong-${tokenIndex}`}>
            {renderInlineMarkdown(innerContent, `${keyPrefix}-strong-${tokenIndex}`)}
          </strong>,
        );
        tokenIndex += 1;
        index = closingIndex + 2;
        continue;
      }
    }

    if (content[index] === '*' && !content.startsWith('**', index)) {
      const closingIndex = content.indexOf('*', index + 1);
      if (closingIndex > index + 1) {
        const innerContent = content.slice(index + 1, closingIndex);
        nodes.push(
          <em key={`${keyPrefix}-em-${tokenIndex}`}>
            {renderInlineMarkdown(innerContent, `${keyPrefix}-em-${tokenIndex}`)}
          </em>,
        );
        tokenIndex += 1;
        index = closingIndex + 1;
        continue;
      }
    }

    if (content[index] === '`') {
      const closingIndex = content.indexOf('`', index + 1);
      if (closingIndex > index + 1) {
        const codeContent = content.slice(index + 1, closingIndex);
        nodes.push(
          <code className="mail-markdown-code" key={`${keyPrefix}-code-${tokenIndex}`}>
            {codeContent}
          </code>,
        );
        tokenIndex += 1;
        index = closingIndex + 1;
        continue;
      }
    }

    if (content[index] === '[') {
      const labelEnd = content.indexOf(']', index + 1);
      const urlStart = labelEnd >= 0 && content[labelEnd + 1] === '(' ? labelEnd + 2 : -1;
      const urlEnd = urlStart >= 0 ? content.indexOf(')', urlStart) : -1;
      if (labelEnd > index + 1 && urlEnd > urlStart) {
        const label = content.slice(index + 1, labelEnd);
        const url = content.slice(urlStart, urlEnd).trim();
        if (SAFE_LINK_RE.test(url)) {
          nodes.push(
            <a
              className="mail-markdown-link"
              href={url}
              key={`${keyPrefix}-link-${tokenIndex}`}
              rel="noreferrer"
              target="_blank"
            >
              {renderInlineMarkdown(label, `${keyPrefix}-link-${tokenIndex}`)}
            </a>,
          );
          tokenIndex += 1;
          index = urlEnd + 1;
          continue;
        }
      }
    }

    let nextIndex = content.length;
    const specialIndices = [
      content.indexOf('\n', index),
      content.indexOf('**', index),
      content.indexOf('*', index),
      content.indexOf('`', index),
      content.indexOf('[', index),
    ].filter((value) => value >= 0);

    for (const specialIndex of specialIndices) {
      if (specialIndex < nextIndex) {
        nextIndex = specialIndex;
      }
    }

    if (nextIndex === index) {
      pushText(content[index] ?? '');
      index += 1;
      continue;
    }

    pushText(content.slice(index, nextIndex));
    index = nextIndex;
  }

  return nodes;
};

const renderMarkdownBlock = (block: MarkdownBlock, index: number): ReactNode => {
  if (block.type === 'heading') {
    const HeadingTag = `h${block.level}` as const;
    return (
      <HeadingTag
        className={`mail-markdown-heading mail-markdown-heading-level-${block.level}`}
        key={`heading-${index}`}
      >
        {renderInlineMarkdown(block.text, `heading-${index}`)}
      </HeadingTag>
    );
  }

  if (block.type === 'paragraph') {
    return (
      <p className="mail-markdown-paragraph" key={`paragraph-${index}`}>
        {renderInlineMarkdown(block.text, `paragraph-${index}`)}
      </p>
    );
  }

  if (block.type === 'unordered_list' || block.type === 'ordered_list') {
    const ListTag = block.type === 'unordered_list' ? 'ul' : 'ol';
    const listClassName = block.type === 'unordered_list'
      ? 'mail-markdown-list mail-markdown-list-unordered'
      : 'mail-markdown-list mail-markdown-list-ordered';
    return (
      <ListTag className={listClassName} key={`list-${index}`}>
        {block.items.map((item, itemIndex) => (
          <li className="mail-markdown-list-item" key={`list-${index}-${itemIndex}`}>
            {renderInlineMarkdown(item, `list-${index}-${itemIndex}`)}
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === 'blockquote') {
    return (
      <blockquote className="mail-markdown-blockquote" key={`blockquote-${index}`}>
        {renderInlineMarkdown(block.text, `blockquote-${index}`)}
      </blockquote>
    );
  }

  return <hr className="mail-markdown-divider" key={`divider-${index}`} />;
};

const MailMarkdownContent: React.FC<MailMarkdownContentProps> = ({ content, className }) => {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <div className={buildMailMarkdownRootClassName(className)}>
      {blocks.map((block, index) => (
        <Fragment key={`mail-markdown-block-${index}`}>
          {renderMarkdownBlock(block, index)}
        </Fragment>
      ))}
    </div>
  );
};

export default MailMarkdownContent;
