import { describe, it, expect, vi } from 'vitest';
import { LocaleManager } from '../src/index.js';

describe('LocaleManager', () => {
  it('returns default english string when no locale is set', () => {
    const manager = new LocaleManager();
    expect(manager.locale).toBe('en-US');
    expect(manager.t('app.title')).toBe('Nexus Editor');
  });

  it('translates strings correctly when locale is changed to zh-CN', () => {
    const manager = new LocaleManager();
    manager.setLocale('zh-CN');
    
    expect(manager.locale).toBe('zh-CN');
    expect(manager.t('app.title')).toBe('Nexus 编辑器');
  });

  it('notifies subscribers when locale changes', () => {
    const manager = new LocaleManager();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);

    manager.setLocale('zh-CN');
    expect(listener).toHaveBeenCalledWith('zh-CN');

    unsubscribe();
    manager.setLocale('en-US');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('interpolates variables into translation strings', () => {
    const manager = new LocaleManager();
    // Assuming we add a key like file.unsupported: "Unsupported format: {format}"
    expect(manager.t('file.unsupported', { format: '.pdf' })).toBe('Unsupported format: .pdf');
  });

  it('falls back to key if translation is missing', () => {
    const manager = new LocaleManager();
    expect(manager.t('missing.key')).toBe('missing.key');
  });

  it('has() 跟 t() 的回落规则一致：缺键返回 false，而不是键名', () => {
    const manager = new LocaleManager();
    expect(manager.has('missing.key')).toBe(false);
    expect(manager.has('theme.description.dracula')).toBe(true);

    manager.setLocale('zh-CN');
    expect(manager.has('theme.description.dracula')).toBe(true);
  });
});
