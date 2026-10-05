import { describe, it, expect } from 'vitest';
import {
  LOG_LEVELS,
  LOG_LEVEL_DEFAULT,
  isLogLevel,
  logLevelAllows,
  parseLogLevel
} from '../src/logging/level.js';

describe('日志级别 · 取值域', () => {
  it('认得的级别原样返回', () => {
    for (const level of LOG_LEVELS) {
      expect(parseLogLevel(level)).toBe(level);
      expect(isLogLevel(level)).toBe(true);
    }
  });

  it('认不出的一律回落默认档 —— 级别删不掉任何东西，所以往「照默认记」倒', () => {
    // 与 `parseHistoryRetention` 的方向相反是有意的：那一项会删数据，未知值必须往
    // 「什么都不做」倒。这里反过来 —— 静默不记日志才是风险。
    expect(parseLogLevel('trace')).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel('INFO')).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel('')).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel(null)).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel(undefined)).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel(2)).toBe(LOG_LEVEL_DEFAULT);
    expect(parseLogLevel({ level: 'debug' })).toBe(LOG_LEVEL_DEFAULT);
    expect(isLogLevel('INFO')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });

  it('`LOG_LEVELS` 的顺序就是严重程度（从最严重到最啰嗦）', () => {
    // 这条是哨兵：设置页的下拉顺序、`logLevelAllows` 的比较都从这个数组取。
    // 有人按字母序重排（debug 会跑到第一个）时，级别过滤会整体反过来 —— 而那种
    // 错误在界面上完全看不出来（下拉照样能用，只是语义反了）。
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it('默认档是最啰嗦的那一档之外最全的一档 —— 不是 error', () => {
    expect(LOG_LEVEL_DEFAULT).toBe('info');
    expect(logLevelAllows(LOG_LEVEL_DEFAULT, 'info')).toBe(true);
    expect(logLevelAllows(LOG_LEVEL_DEFAULT, 'debug')).toBe(false);
  });
});

describe('日志级别 · 放行判断', () => {
  /**
   * 完整矩阵，而不是几个抽样。这一格表是主进程写盘与否的唯一判据，
   * 而它只有 16 个格子 —— 抽样会让「warn 下 error 反而不写」这种错漏过去。
   */
  const EXPECTED: Record<string, string[]> = {
    error: ['error'],
    warn: ['error', 'warn'],
    info: ['error', 'warn', 'info'],
    debug: ['error', 'warn', 'info', 'debug']
  };

  it.each(Object.keys(EXPECTED))('级别设为 %s 时，放行的正好是这几档', (current) => {
    const allowed = LOG_LEVELS.filter((message) => logLevelAllows(current as never, message));
    expect(allowed).toEqual(EXPECTED[current]);
  });

  it('正反两面：调到 error 不是「什么都不写」，调到 debug 也不是「只写 debug」', () => {
    // 「关掉某类东西」的开关必须同时断言另一类还在（判据 25 的同类判断）。
    expect(logLevelAllows('error', 'error')).toBe(true);
    expect(logLevelAllows('error', 'warn')).toBe(false);

    expect(logLevelAllows('debug', 'error')).toBe(true);
    expect(logLevelAllows('debug', 'debug')).toBe(true);
  });
});
