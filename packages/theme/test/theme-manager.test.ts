import { describe, it, expect, vi } from 'vitest';
import { ThemeManager } from '../src/index.js';

describe('ThemeManager', () => {
  it('initializes with light theme by default', () => {
    const manager = new ThemeManager();
    expect(manager.theme).toBe('light');
  });

  it('allows changing theme to dark', () => {
    const manager = new ThemeManager();
    manager.setTheme('dark');
    expect(manager.theme).toBe('dark');
  });

  it('notifies subscribers when theme changes', () => {
    const manager = new ThemeManager();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);

    manager.setTheme('dark');
    expect(listener).toHaveBeenCalledWith('dark');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.setTheme('light');
    expect(listener).toHaveBeenCalledTimes(1); // Should not be called again
  });

  it('does not notify if theme is unchanged', () => {
    const manager = new ThemeManager();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.setTheme('light'); // default is already light
    expect(listener).not.toHaveBeenCalled();
  });
});
