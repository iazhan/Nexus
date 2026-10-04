import { describe, expect, it } from 'vitest';
import {
  applyChangesToSource,
  createInsertDocumentLinkTransaction,
  createInsertTextTransaction,
  type MarkdownSelection
} from '../src/index.js';

/**
 * 「插入到光标」这一条链路的事务层。
 *
 * 这里只断言**写出来的是什么字符串**与**替换了哪一段**；「写出来的能不能被读回来」
 * 是另一件事，跨了 core 与 markdown 两个包，落在 `link-format-roundtrip.test.ts`。
 * 两边分开的理由：这一份答「有没有插错地方」，那一份答「写出来的对不对」——
 * 合成一份的话，插错位置而字符串正确时两边都会绿。
 */

const TARGET = { path: '/vault/notes/dma.md', relativePath: 'notes/dma.md' };
const CURRENT = '/vault/notes/index.md';

/** 光标在 `offset`，无选区。 */
function caret(offset: number): MarkdownSelection {
  return { anchor: offset, head: offset };
}

/** 从 `from` 选到 `to`。 */
function range(from: number, to: number): MarkdownSelection {
  return { anchor: from, head: to };
}

describe('Edit Transactions: Insert Text (P1-2 原语)', () => {
  it('在光标处插入，光标落在插入内容之后', () => {
    const tx = createInsertTextTransaction(caret(3), 'abc');
    expect(tx?.changes).toEqual([{ from: 3, to: 3, insert: 'abc' }]);
    // 接着打字是「在插入内容后面继续写」，不是「把刚插进去的东西改掉」。
    expect(tx?.selection).toEqual({ anchor: 6, head: 6 });
    expect(tx?.userEvent).toBe('input.insertText');
  });

  it('有选区就替换它', () => {
    const tx = createInsertTextTransaction(range(2, 7), 'xy');
    expect(tx?.changes).toEqual([{ from: 2, to: 7, insert: 'xy' }]);
    expect(tx?.selection).toEqual({ anchor: 4, head: 4 });
  });

  it('反选（head 在 anchor 前）与正选同一条结果 —— 区间永远归一化后再切', () => {
    const forward = createInsertTextTransaction(range(2, 7), 'xy');
    const backward = createInsertTextTransaction({ anchor: 7, head: 2 }, 'xy');
    expect(backward).toEqual(forward);
  });

  it('反面：空串不产生事务 —— 一次什么都不做的编辑会白白占一格 undo 栈', () => {
    expect(createInsertTextTransaction(caret(3), '')).toBeNull();
  });
});

describe('Edit Transactions: Insert Document Link (P1-2)', () => {
  it('wikilink 档、空选区 —— 不写别名，退回 `[[名]]`', () => {
    const result = createInsertDocumentLinkTransaction('hello', caret(5), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyChangesToSource('hello', result.transaction.changes)).toBe('hello[[dma]]');
  });

  it('选中文字就是链接文字 —— wikilink 走别名，选中的字**不被吞掉**', () => {
    const source = 'see DMA here';
    const result = createInsertDocumentLinkTransaction(source, range(4, 7), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyChangesToSource(source, result.transaction.changes)).toBe('see [[dma|DMA]] here');
  });

  it('wikilink-path 档 —— 路径段与别名各归各位', () => {
    const source = 'see DMA here';
    const result = createInsertDocumentLinkTransaction(source, range(4, 7), {
      target: TARGET,
      format: 'wikilink-path',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyChangesToSource(source, result.transaction.changes)).toBe('see [[notes/dma|DMA]] here');
  });

  it('markdown 档 —— 相对的是**当前文档所在目录**，文字是选中的那段', () => {
    const source = 'see DMA here';
    const result = createInsertDocumentLinkTransaction(source, range(4, 7), {
      target: TARGET,
      format: 'markdown',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `notes/index.md` 与 `notes/dma.md` 同目录，所以是裸 `dma.md`。
    expect(applyChangesToSource(source, result.transaction.changes)).toBe('see [DMA](dma.md) here');
  });

  it('markdown 档、跨目录 —— 基准是当前文档目录，不是工作区根', () => {
    const result = createInsertDocumentLinkTransaction('', caret(0), {
      target: TARGET,
      format: 'markdown',
      currentDocumentPath: '/vault/archive/old.md'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.changes[0]?.insert).toBe('[dma](../notes/dma.md)');
  });

  it('markdown 档没有当前文档 —— 拒绝，理由要能翻成给用户看的话', () => {
    const result = createInsertDocumentLinkTransaction('', caret(0), {
      target: TARGET,
      format: 'markdown',
      currentDocumentPath: null
    });
    expect(result).toEqual({ ok: false, reason: 'no-current-document' });
  });

  it('三种「不给标签」的选区都退回目标标题 —— 写出来的仍是一条**正确**的链接', () => {
    const fallbacks: Array<[string, string, MarkdownSelection]> = [
      ['空选区（从命令面板调起时就是这样）', 'abc', caret(2)],
      ['跨行选区（换行会把两种语法都弄坏）', 'ab\ncd', range(0, 5)],
      ['只有空白的选区', 'ab   cd', range(2, 5)]
    ];
    for (const [label, source, selection] of fallbacks) {
      const result = createInsertDocumentLinkTransaction(source, selection, {
        target: TARGET,
        format: 'wikilink',
        currentDocumentPath: CURRENT
      });
      expect(result.ok, label).toBe(true);
      if (!result.ok) continue;
      expect(result.transaction.changes[0]?.insert, label).toBe('[[dma]]');
    }
  });

  it('选区首尾的空白不算链接文字的一部分', () => {
    const source = 'see  DMA  here';
    const result = createInsertDocumentLinkTransaction(source, range(3, 10), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.changes[0]?.insert).toBe('[[dma|DMA]]');
  });

  it('反面：目标名含 `]` 时 wikilink 档**拒绝**，不写出语法坏掉的正文', () => {
    const result = createInsertDocumentLinkTransaction('', caret(0), {
      target: { path: '/vault/dm]a.md', relativePath: 'dm]a.md' },
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result).toEqual({ ok: false, reason: 'unescapable-name' });
  });

  it('反面：选中文字含 `|` 时 wikilink 档同样拒绝 —— 别名里的 `|` 会把它切成两半', () => {
    const result = createInsertDocumentLinkTransaction('a|b', range(0, 3), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result).toEqual({ ok: false, reason: 'unescapable-name' });
  });

  it('同一段文字在 markdown 档**能写** —— 它有转义，失败面小得多', () => {
    const result = createInsertDocumentLinkTransaction('a|b', range(0, 3), {
      target: TARGET,
      format: 'markdown',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.changes[0]?.insert).toBe('[a|b](dma.md)');
  });

  it('markdown 档转义文字里的方括号', () => {
    const result = createInsertDocumentLinkTransaction('a[b]c', range(0, 5), {
      target: TARGET,
      format: 'markdown',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.changes[0]?.insert).toBe('[a\\[b\\]c](dma.md)');
  });

  it('别名里允许 `#` —— 解析器按**第一个** `|` 切，别名不再参与锚点切分', () => {
    const result = createInsertDocumentLinkTransaction('C# 入门', range(0, 5), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.changes[0]?.insert).toBe('[[dma|C# 入门]]');
  });

  it('插入不设原子守卫 —— 判据是「纯文本替换不会把谁切两半」，那件事归调用方', () => {
    // 选区整段落在行内代码里，事务照样建得出来（工具栏按钮会自己禁用）。
    const source = 'a `code` b';
    const result = createInsertDocumentLinkTransaction(source, range(3, 7), {
      target: TARGET,
      format: 'wikilink',
      currentDocumentPath: CURRENT
    });
    expect(result.ok).toBe(true);
  });
});
