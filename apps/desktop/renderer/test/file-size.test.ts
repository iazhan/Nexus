import { describe, it, expect } from 'vitest';
import { formatFileSize } from '../src/workspace/file-size.js';

/**
 * 附件行上的大小文本。
 *
 * 判据刻意写**精确值**而不是范围：这个函数唯一的风险就是「差一个单位」或
 * 「多一个小数位」，而范围断言恰好放过这两类错。
 */
describe('文件大小格式化', () => {
  it('小于 1 KB 时按字节显示，不带小数', () => {
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('1024 进一位（1024 进制，不是 1000）', () => {
    // 1000 字节必须还是 B —— 这条能抓住「误用 1000 进制」
    expect(formatFileSize(1000)).toBe('1000 B');
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  it('带单位时保留一位小数，但去掉整数结果的 .0', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('超大数停在 TB，不越界', () => {
    // 单位表用完时必须继续用最后一个单位，而不是回绕到 B 或输出 undefined
    const text = formatFileSize(1024 ** 5);
    expect(text).toBe('1024 TB');
    expect(formatFileSize(1024 ** 8)).toContain('TB');
  });

  it('0 / 负数 / 非有限数一律回 0 B', () => {
    // 索引里 stat 失败写的就是 0；NaN 会一路渲染成 "NaN B"，那种输出像 bug
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(-1)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('0 B');
    expect(formatFileSize(Number.NEGATIVE_INFINITY)).toBe('0 B');
  });
});
