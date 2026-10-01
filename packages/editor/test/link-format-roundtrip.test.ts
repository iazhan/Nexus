import { describe, it, expect } from 'vitest';
import { buildDocumentLink } from '@nexus/core';
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
});
