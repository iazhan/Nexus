import { describe, it, expect } from 'vitest';
import { buildDocumentLink, resolveWikiLink, type IndexedDocument } from '@nexus/core';
import { parseMarkdown, type MarkdownNode } from '@nexus/markdown';
import { resolveRelativePath } from '../src/link-navigation.js';

/**
 * 「写出来的链接必须能被自己读回来」—— 这一条跨了三个包，所以单独一个文件：
 *
 *   core 的 `buildDocumentLink`（写） → `@nexus/markdown` 的 `parseMarkdown`（解析）
 *   → `link-navigation.ts` 的 `resolveRelativePath`（读，就是 Ctrl+点击走的那条）
 *
 * **为什么不把 href 自己从字符串里切出来**：那等于在测试里复刻一遍解析规则，
 * 而解析规则（`<>` 包裹、反斜杠转义）**正是被测的那一环**。手工切的话，链接写成
 * `[x](<a b.md>)` 而解析器不认，测试照样绿。用应用同一个解析器才谈得上「自己读得回来」。
 *
 * 放在 `packages/editor/test/` 而不是 core：`resolveRelativePath` 在 editor 包里，
 * 而 editor 依赖 core 与 markdown，两侧都能 import —— 只有这里凑得齐三个包。
 */

/** 取第一条链接的 href；**解析不出链接**时返回 `null`（负对照要用）。走的是真实产物，不是正则。 */
function firstLinkHref(source: string): string | null {
  const { root } = parseMarkdown(source);
  const queue: MarkdownNode[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    if (node.type === 'link') return node.href;
    const children = (node as { children?: MarkdownNode[] }).children;
    if (children) queue.push(...children);
  }
  return null;
}

/** 当前文档所在目录 —— 就是 `App.tsx` 喂给 `resolveRelativePath` 的那个参数。 */
function directoryOf(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf('/'));
}

/**
 * 一条用例：写出来 → 解析 → 解析回绝对路径 → 必须等于目标自己的路径。
 *
 * `current` 是「用户正在编辑的那篇」的绝对路径，`targetPath` 是右键那一行的。
 */
function expectRoundTrip(current: string, targetPath: string, expectedText: string): void {
  const result = buildDocumentLink(
    { path: targetPath, relativePath: targetPath.replace('/vault/', '') },
    'markdown',
    current
  );
  if (!result.ok) throw new Error(`应当能写出来，却失败了：${result.reason}`);
  expect(result.text).toBe(expectedText);

  const href = firstLinkHref(result.text);
  expect(href).not.toBeNull();
  expect(resolveRelativePath(directoryOf(current), href as string)).toBe(targetPath);
}

describe('Markdown 档链接：写 → 解析 → 读回来', () => {
  it('同目录', () => {
    expectRoundTrip('/vault/notes/dma.md', '/vault/notes/dma.md', '[dma](dma.md)');
  });

  it('跨目录（相对当前文档，不是工作区根）', () => {
    expectRoundTrip('/vault/archive/x.md', '/vault/notes/dma.md', '[dma](../notes/dma.md)');
  });

  it('附件保留全名', () => {
    expectRoundTrip('/vault/notes/dma.md', '/vault/assets/logo.png', '[logo.png](../assets/logo.png)');
  });

  it('路径含空格 —— 靠 <...> 包裹，解析器要把它剥掉', () => {
    expectRoundTrip(
      '/vault/notes/dma.md',
      '/vault/my notes/dma.md',
      '[dma](<../my notes/dma.md>)'
    );
  });

  it('路径含括号 —— 同一套 <...> 包裹', () => {
    expectRoundTrip(
      '/vault/notes/dma.md',
      '/vault/my (old) notes/dma.md',
      '[dma](<../my (old) notes/dma.md>)'
    );
  });

  it('名字含 ] —— 只转义文字，目标照写', () => {
    expectRoundTrip('/vault/notes/dma.md', '/vault/dm]a.md', '[dm\\]a](../dm]a.md)');
  });

  it('负对照：不包 <...> 的话，它**根本不是一条链接**', () => {
    // 这条证明上面那个 `<...>` 不是装饰，而且失败方式比「解析错」更糟：
    // 裸写空格时 `marked` 连 link 节点都不产生 —— 粘进正文里就是原样的方括号语法，
    // 既点不动、也不报错，用户只会以为「链接功能坏了」。
    expect(firstLinkHref('[dma](../my notes/dma.md)')).toBeNull();
    // 包上就有了
    expect(firstLinkHref('[dma](<../my notes/dma.md>)')).toBe('../my notes/dma.md');
  });

  it('选了文字当链接文字 —— 文字变了，目标照旧', () => {
    const result = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'markdown',
      '/vault/notes/index.md',
      'DMA 那篇'
    );
    if (!result.ok) throw new Error(`应当能写出来，却失败了：${result.reason}`);
    expect(result.text).toBe('[DMA 那篇](dma.md)');
    expect(resolveRelativePath('/vault/notes', firstLinkHref(result.text) as string)).toBe(
      '/vault/notes/dma.md'
    );
  });
});

/**
 * wikilink 侧的同一件事。
 *
 * 读的那一半是 `resolveWikiLink`，它吃的是**目标名**而不是整条语法 ——
 * 所以这里必须先过一遍 `parseMarkdown` 把 `target` / `alias` 切出来，
 * 不能自己按 `|` 切：切法本身（第一个 `|` 之前是目标）正是被测的那一环。
 */
function firstWikilink(source: string): { target: string; alias?: string } | null {
  const { root } = parseMarkdown(source);
  const queue: MarkdownNode[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    if (node.type === 'wikilink') return { target: node.target, alias: node.alias };
    const children = (node as { children?: MarkdownNode[] }).children;
    if (children) queue.push(...children);
  }
  return null;
}

/** 索引里的一篇文档。只有 `resolveWikiLink` 会读的三个字段是真的。 */
function indexed(path: string): IndexedDocument {
  const relativePath = path.replace('/vault/', '');
  return {
    id: 0,
    path,
    relativePath,
    name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
    title: relativePath,
    type: 'note',
    sizeBytes: 0,
    modifiedAtMs: 0,
    contentHash: '',
    extractionStatus: 'none'
  };
}

const DOCS: readonly IndexedDocument[] = [
  indexed('/vault/notes/dma.md'),
  indexed('/vault/assets/logo.png')
];

describe('wikilink 档链接：写 → 解析 → 读回来', () => {
  it('只写名字', () => {
    const result = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink',
      '/vault/notes/index.md'
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).toBe('[[dma]]');

    const parsed = firstWikilink(result.text);
    expect(parsed).toEqual({ target: 'dma' });
    expect(resolveWikiLink(parsed!.target, DOCS).document?.path).toBe('/vault/notes/dma.md');
  });

  it('写工作区根相对路径 —— 从哪篇文档引用都写出同一串', () => {
    const fromA = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink-path',
      '/vault/a.md'
    );
    const fromB = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink-path',
      '/vault/deep/b.md'
    );
    if (!fromA.ok || !fromB.ok) throw new Error('应当能写出来');
    expect(fromA.text).toBe('[[notes/dma]]');
    expect(fromB.text).toBe(fromA.text);

    expect(resolveWikiLink(firstWikilink(fromA.text)!.target, DOCS).document?.path).toBe(
      '/vault/notes/dma.md'
    );
  });

  it('别名不参与「指向哪一篇」的判断 —— 解析器切掉它之后照样解析到同一篇', () => {
    const result = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink',
      '/vault/notes/index.md',
      'DMA 那篇'
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).toBe('[[dma|DMA 那篇]]');

    const parsed = firstWikilink(result.text);
    expect(parsed).toEqual({ target: 'dma', alias: 'DMA 那篇' });
    expect(resolveWikiLink(parsed!.target, DOCS).document?.path).toBe('/vault/notes/dma.md');
  });

  it('别名里的 `#` 不会被当成锚点 —— 切分只发生在目标那一半', () => {
    const result = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink',
      '/vault/notes/index.md',
      'C# 入门'
    );
    if (!result.ok) throw new Error(result.reason);

    const parsed = firstWikilink(result.text);
    expect(parsed).toEqual({ target: 'dma', alias: 'C# 入门' });
    expect(resolveWikiLink(parsed!.target, DOCS).document?.path).toBe('/vault/notes/dma.md');
  });

  it('附件保留全名 —— `[[logo]]` 在同名 .md 存在时会归 .md', () => {
    const result = buildDocumentLink(
      { path: '/vault/assets/logo.png', relativePath: 'assets/logo.png' },
      'wikilink',
      '/vault/notes/index.md'
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).toBe('[[logo.png]]');
    expect(resolveWikiLink(firstWikilink(result.text)!.target, DOCS).document?.path).toBe(
      '/vault/assets/logo.png'
    );
  });

  it('负对照：目标名含 `]` 时拒绝，而不是写出一条语法坏掉的正文', () => {
    const result = buildDocumentLink(
      { path: '/vault/dm]a.md', relativePath: 'dm]a.md' },
      'wikilink',
      '/vault/notes/index.md'
    );
    expect(result).toEqual({ ok: false, reason: 'unescapable-name' });
  });

  it('负对照：别名含 `|` 时同样拒绝 —— 写出来的话解析器会把它切成两半', () => {
    const result = buildDocumentLink(
      { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' },
      'wikilink',
      '/vault/notes/index.md',
      'a|b'
    );
    expect(result).toEqual({ ok: false, reason: 'unescapable-name' });
  });
});
