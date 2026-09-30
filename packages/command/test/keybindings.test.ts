import { describe, it, expect } from 'vitest';
import {
  UNBOUND,
  createKeybindingTable,
  parseKeybindingOverrides,
  serializeKeybindingOverrides
} from '../src/index.js';

const DEFAULTS = {
  'save': 'Mod-S',
  'new-file': 'Mod-N',
  'toggle-surface': 'Mod-M',
  'settings.open': 'Mod-,'
};

describe('parseKeybindingOverrides', () => {
  it('读回一张表，并把值规范化', () => {
    expect(parseKeybindingOverrides('{"save":"Shift-Mod-s"}')).toEqual({ save: 'Mod-Shift-s' });
  });

  it('空 / 坏 JSON / 非对象一律回空表，不抛', () => {
    expect(parseKeybindingOverrides(null)).toEqual({});
    expect(parseKeybindingOverrides('')).toEqual({});
    expect(parseKeybindingOverrides('not json')).toEqual({});
    expect(parseKeybindingOverrides('["save"]')).toEqual({});
    expect(parseKeybindingOverrides('"save"')).toEqual({});
  });

  it('坏**项**丢掉而不是拒整份', () => {
    expect(parseKeybindingOverrides('{"save":"Mod-S","bad":42,"bare":"s"}')).toEqual({
      save: 'Mod-s'
    });
  });

  it('空串是「显式取消绑定」，与「没有这一项」分开保留', () => {
    expect(parseKeybindingOverrides('{"save":""}')).toEqual({ save: UNBOUND });
  });
});

describe('serializeKeybindingOverrides', () => {
  it('空表写空串', () => {
    expect(serializeKeybindingOverrides({})).toBe('');
  });

  it('键排序 —— 两个窗口各写一次时输出必须一致', () => {
    expect(serializeKeybindingOverrides({ save: 'Mod-s', 'new-file': 'Mod-n' })).toBe(
      '{"new-file":"Mod-n","save":"Mod-s"}'
    );
  });

  it('往返一致', () => {
    const table = { 'save': 'Mod-Shift-s', 'toggle-surface': UNBOUND };
    expect(parseKeybindingOverrides(serializeKeybindingOverrides(table))).toEqual(table);
  });
});

describe('createKeybindingTable', () => {
  it('没覆盖过的项回落默认', () => {
    const table = createKeybindingTable(DEFAULTS, {});
    expect(table.resolve('save')).toBe('Mod-S');
    expect(table.resolve('missing')).toBeUndefined();
  });

  it('覆盖优先于默认', () => {
    const table = createKeybindingTable(DEFAULTS, { save: 'Mod-Shift-s' });
    expect(table.resolve('save')).toBe('Mod-Shift-s');
    expect(table.isOverridden('save')).toBe(true);
    expect(table.isOverridden('new-file')).toBe(false);
  });

  it('空串覆盖 = 取消绑定，**不会被默认值顶回来**', () => {
    const table = createKeybindingTable(DEFAULTS, { save: UNBOUND });
    expect(table.resolve('save')).toBeUndefined();
    expect(table.isOverridden('save')).toBe(true);
    expect(table.entries().map((entry) => entry.id)).not.toContain('save');
  });

  it('entries 的顺序取默认表键序，覆盖表新增的排在后面', () => {
    const table = createKeybindingTable(DEFAULTS, { 'extra': 'Mod-Shift-e' });
    expect(table.entries().map((entry) => entry.id)).toEqual([
      'save',
      'new-file',
      'toggle-surface',
      'settings.open',
      'extra'
    ]);
  });

  it('冲突检测按规范形比对 —— 写法不同但同一个组合键也算冲突', () => {
    const table = createKeybindingTable(DEFAULTS, {});
    expect(table.conflicts('mod-s')).toEqual(['save']);
    // `Mod-Ctrl-s` 与 `Mod-s` 实际匹配同一批事件（`Mod` 在场时 `Ctrl` 不参与匹配），
    // 不归一的话这一对「字符串不同、行为相同」的绑定会被漏掉。
    expect(table.conflicts('Mod-Ctrl-s')).toEqual(['save']);
    expect(table.conflicts('Mod-S', 'save')).toEqual([]);
  });

  it('非法串没有冲突，也匹配不到任何东西', () => {
    const table = createKeybindingTable(DEFAULTS, {});
    expect(table.conflicts('s')).toEqual([]);
    expect(table.conflicts('')).toEqual([]);
  });

  it('取消绑定的项不参与冲突检测', () => {
    const table = createKeybindingTable(DEFAULTS, { save: UNBOUND });
    expect(table.conflicts('Mod-S')).toEqual([]);
  });
});
