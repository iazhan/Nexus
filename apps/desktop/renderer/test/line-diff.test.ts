import { describe, it, expect } from 'vitest';
import { diffLines } from '../src/workspace/line-diff.js';

describe('行级差异', () => {
  it('相同内容全是 same', () => {
    const result = diffLines('a\nb\n', 'a\nb\n');
    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' }
    ]);
  });

  it('改一行呈现为「删旧行 + 加新行」', () => {
    const result = diffLines('a\nb\nc\n', 'a\nB\nc\n');

    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' }
    ]);
  });

  it('新增行只有 added', () => {
    const result = diffLines('a\nc\n', 'a\nb\nc\n');
    expect(result.filter((line) => line.kind === 'removed')).toEqual([]);
    expect(result.filter((line) => line.kind === 'added')).toEqual([{ kind: 'added', text: 'b' }]);
  });

  it('删除行只有 removed', () => {
    const result = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(result.filter((line) => line.kind === 'added')).toEqual([]);
    expect(result.filter((line) => line.kind === 'removed')).toEqual([
      { kind: 'removed', text: 'b' }
    ]);
  });

  it('空与空没有差异', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('从空到有内容全是 added', () => {
    expect(diffLines('', 'a\nb\n')).toEqual([
      { kind: 'added', text: 'a' },
      { kind: 'added', text: 'b' }
    ]);
  });

  it('从有内容到空全是 removed', () => {
    expect(diffLines('a\nb\n', '')).toEqual([
      { kind: 'removed', text: 'a' },
      { kind: 'removed', text: 'b' }
    ]);
  });

  it('结尾的换行不产生多余的空行', () => {
    // 'a\n' 只有一行 'a'；如果不处理 split 的尾部空串，这里会多出一条 same('')
    const result = diffLines('a\n', 'a\n');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'same', text: 'a' });
  });

  it('中间的空行是有意义的一行', () => {
    const result = diffLines('a\n\nb\n', 'a\n\nb\n');
    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: '' },
      { kind: 'same', text: 'b' }
    ]);
  });

  it('删除中间的空行会被识别', () => {
    const result = diffLines('a\n\nb\n', 'a\nb\n');
    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: '' },
      { kind: 'same', text: 'b' }
    ]);
  });

  it('支持中文与 emoji', () => {
    const result = diffLines('公式 $E = mc^2$\n', '公式 $E = mc^3$\n');
    expect(result).toContainEqual({ kind: 'removed', text: '公式 $E = mc^2$' });
    expect(result).toContainEqual({ kind: 'added', text: '公式 $E = mc^3$' });
  });

  it('超出行数上限时退化成整体替换，但内容不丢', () => {
    const before = Array.from({ length: 3001 }, (_, i) => `旧 ${i}`).join('\n');
    const after = Array.from({ length: 3001 }, (_, i) => `新 ${i}`).join('\n');

    const result = diffLines(before, after);

    expect(result.filter((line) => line.kind === 'removed')).toHaveLength(3001);
    expect(result.filter((line) => line.kind === 'added')).toHaveLength(3001);
    expect(result.filter((line) => line.kind === 'same')).toHaveLength(0);
  });

  it('差异行的集合覆盖了两侧的原始内容', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nx\nc\nd\n';
    const result = diffLines(before, after);

    const removedText = result.filter((l) => l.kind !== 'added').map((l) => l.text);
    const addedText = result.filter((l) => l.kind !== 'removed').map((l) => l.text);

    expect(removedText.join('\n')).toBe('a\nb\nc');
    expect(addedText.join('\n')).toBe('a\nx\nc\nd');
  });
});
