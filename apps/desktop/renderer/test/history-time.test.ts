// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { formatSavedAt } from '../src/workspace/history-time.js';

/**
 * 历史时间按**本机时区**渲染。
 *
 * 固定成 `Asia/Shanghai`（GMT+8）来断言，否则结果会随开发机 / CI 的时区漂移。
 * 用完必须还原 —— 同进程里其他测试可能依赖默认时区（沿用本仓库对 locale 的同一规矩）。
 */
describe('历史时间显示', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

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
