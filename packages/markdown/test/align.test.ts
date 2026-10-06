import { describe, it, expect } from 'vitest';
import { alignBlocks } from '../src/align.js';
import { parseMarkdown } from '../src/parser.js';
import { serializeMarkdown } from '../src/serializer.js';

/** 用空行拼一份文档（代码块这类内部含空行的内容要自己写字符串，别用它）。 */
const doc = (...blocks: string[]): string => `${blocks.join('\n\n')}\n`;

describe('块级对齐', () => {
  it('两侧完全相同 → 全 same，且左右逐字相同', () => {
    const src = doc('# 标题', '正文一段。', '- 列表项');
    const rows = alignBlocks(src, src);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'same']);
    for (const row of rows) expect(row.left).toBe(row.right);
  });

  it('尾部纯追加 → 原有全 same + 尾部 right-only', () => {
    const left = doc('# 标题', '正文一段。');
    const right = doc('# 标题', '正文一段。', '新加的一段。');
    const rows = alignBlocks(left, right);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'right-only']);
    expect(rows[2]!.right).toContain('新加的一段');
    expect(rows[2]!.left).toBeNull();
    expect(rows[2]!.leftIndex).toBeNull();
  });

  it('删掉一块 → left-only', () => {
    const left = doc('# 标题', '正文一段。', '会被删的。');
    const right = doc('# 标题', '正文一段。');
    const rows = alignBlocks(left, right);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'left-only']);
    expect(rows[2]!.left).toContain('会被删的');
    expect(rows[2]!.right).toBeNull();
  });

  it('改一块（首行相似）→ changed，其余 same', () => {
    // 用长一点的块：Levenshtein 按最长边归一，短块对改动更敏感（见下面那条）。
    const left = doc('# 标题', '这一段说明讲的是缓存策略，以及它在读路径上的取舍。');
    const right = doc('# 标题', '这一段说明讲的是缓存失效策略，以及它在读路径上的取舍。');
    const rows = alignBlocks(left, right);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'changed']);
    expect(rows[1]!.left).toContain('缓存策略');
    expect(rows[1]!.right).toContain('缓存失效策略');
    // changed 两侧都必须有内容 —— 它是「同一块的两种版本」，不是增删
    expect(rows[1]!.left).not.toBe(rows[1]!.right);
  });

  it('短块的小改动会掉到阈值下，表现为增删（阈值行为的记录）', () => {
    // Levenshtein 按最长边归一：11 个字改 2 个还剩 0.82，改 3 个就掉到 0.79。
    // 短块的「改一句」因此常常呈现为 left-only + right-only —— 这不是缺陷，是
    // 「宁可让用户自己看两块，也不硬凑成一块」这个取舍的直接结果（阈值 0.8 取自 Tine）。
    const left = doc('缓存策略。');
    const right = doc('缓存失效策略。');
    expect(alignBlocks(left, right).map((r) => r.kind)).toEqual(['left-only', 'right-only']);
  });

  it('首行不相似 → 老实标增删，不硬凑成 changed', () => {
    const left = doc('完全不同的开头甲。');
    const right = doc('毫不相干的另一件事乙。');
    const rows = alignBlocks(left, right);
    expect(rows.map((r) => r.kind)).toEqual(['left-only', 'right-only']);
  });

  it('空文档的各种组合', () => {
    expect(alignBlocks('', doc('# 标题')).map((r) => r.kind)).toEqual(['right-only']);
    expect(alignBlocks(doc('# 标题'), '').map((r) => r.kind)).toEqual(['left-only']);
    expect(alignBlocks('', '')).toEqual([]);
    expect(alignBlocks('\n\n  \n', doc('甲。')).map((r) => r.kind)).toEqual(['right-only']);
  });

  it('CRLF 与 LF 的同一份内容不被判成两块不同的东西', () => {
    // 注意 `doc()` 用空行拼接：`- 项一\n\n- 项二` 在 marked 眼里是**一个松散列表**（3 块），
    // 不是两个列表。
    const lf = '# 标题\n\n正文一段。\n\n- 项一\n- 项二\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(alignBlocks(lf, crlf).map((r) => r.kind)).toEqual(['same', 'same', 'same']);
  });

  it('块被移动：不丢块（顺序变化允许表现为增删）', () => {
    const left = doc('甲。', '乙。', '丙。');
    const right = doc('乙。', '丙。', '甲。');
    const rows = alignBlocks(left, right);
    const seen = rows.flatMap((r) => [r.left, r.right]).filter((s): s is string => s !== null);
    for (const text of ['甲。', '乙。', '丙。']) {
      expect(seen.some((s) => s.includes(text))).toBe(true);
    }
  });

  it('下标各自单调递增', () => {
    const left = doc('甲。', '乙。', '丙。', '丁。');
    const right = doc('甲。', '乙改。', '丙。');
    const rows = alignBlocks(left, right);
    const leftIdx = rows.map((r) => r.leftIndex).filter((i): i is number => i !== null);
    const rightIdx = rows.map((r) => r.rightIndex).filter((i): i is number => i !== null);
    expect(leftIdx).toEqual([...leftIdx].sort((a, b) => a - b));
    expect(rightIdx).toEqual([...rightIdx].sort((a, b) => a - b));
    expect(new Set(leftIdx).size).toBe(leftIdx.length);
    expect(new Set(rightIdx).size).toBe(rightIdx.length);
  });

  it('代码块 / 表格 / 引用各算一块，不因内部空行被拆开', () => {
    const src = '# 标题\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n> 引用第一行\n>\n> 引用第二行\n';
    const rows = alignBlocks(src, src);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'same']);
    expect(rows[1]!.left).toContain('const b = 2;');
    expect(rows[2]!.left).toContain('引用第二行');
  });

  it('对齐是只读的：往返不变量不受影响', () => {
    const src = '# 标题\n\n正文一段。\n\n```js\nconst a = 1;\n```\n';
    alignBlocks(src, `${src}\n尾巴。\n`);
    expect(serializeMarkdown(parseMarkdown(src))).toBe(src);
  });

  it('幂等：同一份文档自比全 same，块数等于顶层块数', () => {
    const src = doc('# 一', '正文。', '## 二', '- 项', '> 引用');
    const rows = alignBlocks(src, src);
    expect(rows).toHaveLength(parseMarkdown(src).root.children.length);
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
  });

  it('块数超限 → 退化为整体增删（上限的代价，钉住它）', () => {
    // 上限的意义是「宁可粗，不要卡」。超限时**连自比都会退化** —— 这是已知代价。
    // 钉住它，免得将来有人把上限调小却不改这条断言。
    const big = `${Array.from({ length: 3001 }, (_, i) => `第 ${i} 段。`).join('\n\n')}\n`;
    const rows = alignBlocks(big, big);
    expect(rows).toHaveLength(6002);
    expect(rows.some((r) => r.kind === 'same')).toBe(false);
  });
});
