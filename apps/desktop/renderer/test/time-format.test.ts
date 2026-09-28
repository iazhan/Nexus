// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { formatSavedAt, formatTimestamp } from '../src/workspace/time-format.js';

/**
 * 时间显示按**本机时区**渲染。
 *
 * 固定成 `Asia/Shanghai`（GMT+8）来断言，否则结果会随开发机 / CI 的时区漂移。
 * 用完必须还原 —— 同进程里其他测试可能依赖默认时区（沿用本仓库对 locale 的同一规矩）。
 */
describe('时间显示格式化', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  describe('历史快照时间（字符串输入）', () => {
    it('把 UTC 时间戳转成本机时间（GMT+8），而不是显示 UTC', () => {
      // 10:30 UTC = 18:30 北京时间 —— 显示 10:30 就是这个 bug 的表现
      expect(formatSavedAt('20260926T103000')).toBe('2026-09-26 18:30');
    });

    it('跨 UTC 日界时按本地日期显示', () => {
      // 20:00 UTC = 次日 04:00 北京时间
      expect(formatSavedAt('20260926T200000')).toBe('2026-09-27 04:00');
    });

    it('个位数的月 / 日 / 时 / 分补零', () => {
      // 01:05 UTC = 09:05 北京时间
      expect(formatSavedAt('20260101T010500')).toBe('2026-01-01 09:05');
    });

    it('形状不对时原样返回，不抛错', () => {
      expect(formatSavedAt('not-a-timestamp')).toBe('not-a-timestamp');
      expect(formatSavedAt('')).toBe('');
      // 带冒号 / 带毫秒的都不是存储格式
      expect(formatSavedAt('2026-09-26T10:30:00')).toBe('2026-09-26T10:30:00');
    });
  });

  describe('文件修改时间（毫秒输入）', () => {
    it('按本机时间显示到分钟', () => {
      expect(formatTimestamp(Date.UTC(2026, 8, 26, 10, 30, 0))).toBe('2026-09-26 18:30');
    });

    it('跨 UTC 日界时按本地日期显示', () => {
      expect(formatTimestamp(Date.UTC(2026, 8, 26, 20, 0, 0))).toBe('2026-09-27 04:00');
    });

    it('0 与非有限数返回空串，而不是 1970 年', () => {
      // stat 失败时 mtimeMs 是 0。渲染成 "1970-01-01 08:00" 看起来像真的假时间，
      // 比什么都不显示更糟。
      expect(formatTimestamp(0)).toBe('');
      expect(formatTimestamp(-1)).toBe('');
      expect(formatTimestamp(Number.NaN)).toBe('');
      expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('');
    });

    it('与 formatSavedAt 对同一时刻给出同一个字符串', () => {
      // 这条钉的是「两个函数共享一种输出格式」这个约定 —— 如果哪天有人只改了其中一个
      // 的格式（比如加上秒），这里会红。
      const sameMoment = Date.UTC(2026, 8, 26, 10, 30, 0);
      expect(formatTimestamp(sameMoment)).toBe(formatSavedAt('20260926T103000'));
    });
  });
});
