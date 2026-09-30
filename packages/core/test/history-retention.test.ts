import { describe, it, expect } from 'vitest';
import {
  HISTORY_RETENTION_DEFAULT,
  HISTORY_RETENTION_OPTIONS,
  HISTORY_RETENTION_UNLIMITED,
  entriesToTrim,
  parseHistoryRetention
} from '../src/history/retention.js';
import type { HistoryEntry } from '../src/types/file.js';

/** 造一份「新的在前」的条目表，只关心条数。 */
function entries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    savedAt: `2026090${index % 10}T000000`,
    hash: index.toString(16).padStart(8, '0'),
    sizeBytes: 1
  }));
}

describe('parseHistoryRetention · 取值域', () => {
  it('unlimited 与 null / undefined 都得到「不清理」', () => {
    expect(parseHistoryRetention(HISTORY_RETENTION_UNLIMITED)).toBeNull();
    expect(parseHistoryRetention(null)).toBeNull();
    expect(parseHistoryRetention(undefined)).toBeNull();
  });

  it('数字串得到对应的上限', () => {
    expect(parseHistoryRetention('20')).toBe(20);
    expect(parseHistoryRetention('100')).toBe(100);
    expect(parseHistoryRetention('200')).toBe(200);
  });

  it('**认不出的值一律当不清理** —— 这是数据安全的方向，不是容错', () => {
    // 回落成某个数字意味着「存档里一个坏值就开始删东西」，而删除不可逆。
    expect(parseHistoryRetention('')).toBeNull();
    expect(parseHistoryRetention('abc')).toBeNull();
    expect(parseHistoryRetention('-1')).toBeNull();
    expect(parseHistoryRetention('0')).toBeNull();
    expect(parseHistoryRetention('1.5')).toBeNull();
    expect(parseHistoryRetention('NaN')).toBeNull();
    expect(parseHistoryRetention('Infinity')).toBeNull();
  });

  it('首尾空白是写法噪声，不是坏值 —— `Number` 自己会吃掉', () => {
    expect(parseHistoryRetention(' 20 ')).toBe(20);
  });

  it('默认档位本身是可解析的，且在档位表里', () => {
    // 这两条是「默认值被改成坏值」的哨兵：改了字符串却忘了改档位表，默认就落回不清理，
    // 而那是**静默**的 —— 界面上仍显示 100，实际永远不修剪。
    expect(HISTORY_RETENTION_OPTIONS).toContain(HISTORY_RETENTION_DEFAULT);
    expect(parseHistoryRetention(HISTORY_RETENTION_DEFAULT)).toBe(Number(HISTORY_RETENTION_DEFAULT));
  });

  it('档位表里除 unlimited 外每一项都解析得出数字', () => {
    for (const option of HISTORY_RETENTION_OPTIONS) {
      if (option === HISTORY_RETENTION_UNLIMITED) continue;
      expect(parseHistoryRetention(option)).toBe(Number(option));
    }
  });
});

describe('entriesToTrim · 挑出该删的那一截', () => {
  it('不超上限时一个都不删', () => {
    expect(entriesToTrim(entries(3), 5)).toEqual([]);
  });

  it('正好等于上限时一个都不删', () => {
    expect(entriesToTrim(entries(5), 5)).toEqual([]);
  });

  it('超出上限时删掉尾巴（最旧的），保留头部', () => {
    const list = entries(5);
    const doomed = entriesToTrim(list, 2);

    expect(doomed).toHaveLength(3);
    // 留下的必须是前两个 —— 也就是最新的两份
    expect(doomed).toEqual(list.slice(2));
    expect(list.slice(0, 2)).not.toContainEqual(doomed[0]);
  });

  it('不清理时不删', () => {
    expect(entriesToTrim(entries(500), null)).toEqual([]);
  });

  it('上限为 0 或负数时不删 —— `slice(0)` 会把整个历史清空，坏值不该有这种能力', () => {
    expect(entriesToTrim(entries(5), 0)).toEqual([]);
    expect(entriesToTrim(entries(5), -3)).toEqual([]);
  });

  it('空表不删', () => {
    expect(entriesToTrim([], 3)).toEqual([]);
  });
});
