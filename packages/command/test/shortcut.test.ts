// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  parseShortcut,
  formatShortcut,
  matchesShortcut,
  normalizeShortcut,
  shortcutFromEvent,
  type ShortcutDescriptor
} from '../src/index.js';

/**
 * 非 Apple 平台的判据来自 `navigator.platform`。happy-dom 默认给的是空串，
 * `isApplePlatform()` 因此为 `false` —— 正是这些断言要的前提。Apple 分支不在这里测：
 * 它需要改全局 `navigator`，而两套平台的差异只有「Mod 落在哪个物理键」与符号表两处。
 */
describe('shortcut parsing, formatting and matching', () => {
  describe('parseShortcut', () => {
    it('parses simple mod shortcut', () => {
      const parsed = parseShortcut('Mod-S');
      expect(parsed).toEqual({
        mod: true,
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        key: 's'
      });
    });

    it('parses compound shortcut with Shift and Alt', () => {
      const parsed = parseShortcut('Mod-Shift-S');
      expect(parsed).toEqual({
        mod: true,
        ctrl: false,
        alt: false,
        shift: true,
        meta: false,
        key: 's'
      });
    });

    it('parses explicit Ctrl and Meta', () => {
      const parsed = parseShortcut('Ctrl-Alt-K');
      expect(parsed).toEqual({
        mod: false,
        ctrl: true,
        alt: true,
        shift: false,
        meta: false,
        key: 'k'
      });
    });
  });

  describe('formatShortcut', () => {
    it('formats Mod-S as Ctrl+S on non-Apple platform', () => {
      expect(formatShortcut('Mod-S')).toBe('Ctrl+S');
    });

    it('formats ShortcutDescriptor directly', () => {
      const desc: ShortcutDescriptor = {
        mod: true,
        ctrl: false,
        alt: false,
        shift: true,
        meta: false,
        key: 's'
      };
      expect(formatShortcut(desc)).toBe('Ctrl+Shift+S');
    });
  });

  describe('matchesShortcut', () => {
    it('matches Mod-K with Ctrl+k on Windows/Linux', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        key: 'k'
      });
      expect(matchesShortcut(event, 'Mod-K')).toBe(true);
      expect(matchesShortcut(event, 'Mod-S')).toBe(false);
    });

    it('matches Mod-Shift-S with Ctrl+Shift+s', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 'S'
      });
      expect(matchesShortcut(event, 'Mod-Shift-S')).toBe(true);
      // should not match Mod-S without Shift
      expect(matchesShortcut(event, 'Mod-S')).toBe(false);
    });

    it('does not match when unrequested modifier is pressed', () => {
      const event = new KeyboardEvent('keydown', {
        ctrlKey: true,
        altKey: true,
        key: 'k'
      });
      expect(matchesShortcut(event, 'Mod-K')).toBe(false);
    });
  });

  describe('normalizeShortcut', () => {
    it('重排修饰键并小写键名', () => {
      expect(normalizeShortcut('Shift-Mod-S')).toBe('Mod-Shift-s');
      expect(normalizeShortcut('mod-s')).toBe('Mod-s');
    });

    it('Mod 在场时丢掉显式的 Ctrl / Meta —— 它们本来就不参与匹配', () => {
      expect(normalizeShortcut('Mod-Ctrl-s')).toBe('Mod-s');
      expect(normalizeShortcut('Meta-Mod-s')).toBe('Mod-s');
    });

    it('保留 Apple 上合法的 Ctrl 组合（不带 Mod）', () => {
      expect(normalizeShortcut('Ctrl-Shift-k')).toBe('Ctrl-Shift-k');
    });

    it('裸键与只有修饰键的串一律非法', () => {
      expect(normalizeShortcut('s')).toBeNull();
      expect(normalizeShortcut('Mod-')).toBeNull();
      expect(normalizeShortcut('')).toBeNull();
      expect(normalizeShortcut('Mod-Shift')).toBeNull();
    });

    it('具名键原样保留', () => {
      expect(normalizeShortcut('Mod-F1')).toBe('Mod-F1');
      expect(normalizeShortcut('Alt-ArrowUp')).toBe('Alt-ArrowUp');
    });
  });

  describe('shortcutFromEvent', () => {
    const event = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

    it('非 Apple 上把 Ctrl 映射成 Mod', () => {
      expect(shortcutFromEvent(event({ ctrlKey: true, key: 's' }))).toBe('Mod-s');
    });

    it('按住 Shift 时 event.key 是大写，规格串里仍存小写', () => {
      expect(shortcutFromEvent(event({ ctrlKey: true, shiftKey: true, key: 'S' }))).toBe(
        'Mod-Shift-s'
      );
    });

    it('修饰键单独按下不算一次输入', () => {
      expect(shortcutFromEvent(event({ ctrlKey: true, key: 'Control' }))).toBeNull();
      expect(shortcutFromEvent(event({ shiftKey: true, key: 'Shift' }))).toBeNull();
      expect(shortcutFromEvent(event({ key: 'Meta' }))).toBeNull();
    });

    it('无修饰键的裸键不算快捷键 —— 放行会让键盘失效', () => {
      expect(shortcutFromEvent(event({ key: 'a' }))).toBeNull();
      expect(shortcutFromEvent(event({ key: 'Escape' }))).toBeNull();
    });

    it('具名键与多修饰键', () => {
      expect(shortcutFromEvent(event({ ctrlKey: true, altKey: true, key: 'ArrowUp' }))).toBe(
        'Mod-Alt-ArrowUp'
      );
    });

    it('捕获出来的串能被 normalizeShortcut 原样接受（往返一致）', () => {
      const captured = shortcutFromEvent(event({ ctrlKey: true, shiftKey: true, key: 'K' }))!;
      expect(normalizeShortcut(captured)).toBe(captured);
    });
  });
});
