// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  parseShortcut,
  formatShortcut,
  matchesShortcut,
  type ShortcutDescriptor
} from '../renderer/src/shortcut.js';

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
});
