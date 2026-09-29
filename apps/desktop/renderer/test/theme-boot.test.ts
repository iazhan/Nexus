import { describe, it, expect } from 'vitest';
import { SYSTEM_THEME, THEME_STORAGE_KEY } from '@nexus/theme';
import { installThemeBoot } from '../../preload/theme-boot.js';

describe('installThemeBoot', () => {
  it('根元素已存在时立刻写 data-theme，用归一后的 id', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    document.documentElement.removeAttribute('data-theme');

    installThemeBoot(document, window);

    expect(document.documentElement.dataset.theme).toBe('nexus-dark');
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it('存档是「跟随系统」时 preload 就解析成 id —— CSS 选择器只认 id', () => {
    const fakeDoc = { documentElement: { dataset: {} as Record<string, string> } };
    const fakeWin = {
      localStorage: { getItem: () => SYSTEM_THEME },
      matchMedia: () => ({ matches: true })
    };

    installThemeBoot(fakeDoc as unknown as Document, fakeWin as unknown as Window);

    expect(fakeDoc.documentElement.dataset.theme).toBe('nexus-dark');
  });

  it('认不出的 id 在 preload 就换成跟随系统的结果 —— 静态 CSS 里没有它，写出去等于没有变量', () => {
    const fakeDoc = { documentElement: { dataset: {} as Record<string, string> } };
    const fakeWin = {
      // 上游方案现在有一百多套，随口写一个「像主题名的」字符串很可能真的在表里
      // （`solarized-light` 就是这样失效的）—— 用一个构造上不可能存在的 id。
      localStorage: { getItem: () => 'no-such-theme' },
      matchMedia: () => ({ matches: false })
    };

    installThemeBoot(fakeDoc as unknown as Document, fakeWin as unknown as Window);

    expect(fakeDoc.documentElement.dataset.theme).toBe('nexus-light');
  });

  it('根元素尚未出现时挂观察者，<html> 出现后再写', () => {
    const callbacks: Array<() => void> = [];
    const fakeDoc = { documentElement: null as { dataset: Record<string, string> } | null };
    const Original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof MutationObserver;

    try {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      installThemeBoot(fakeDoc as unknown as Document, window);

      // 实测：preload 执行时根元素还不存在，所以走的一定是这条分支。
      expect(callbacks).toHaveLength(1);
      expect(fakeDoc.documentElement).toBeNull();

      fakeDoc.documentElement = { dataset: {} };
      callbacks[0]!();
      expect(fakeDoc.documentElement.dataset.theme).toBe('nexus-light');
    } finally {
      globalThis.MutationObserver = Original;
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  });

  it('存储不可用时按系统偏好回落，不抛错', () => {
    const fakeDoc = { documentElement: { dataset: {} as Record<string, string> } };
    const fakeWin = {
      localStorage: {
        getItem(): string {
          throw new Error('storage disabled');
        }
      },
      matchMedia: () => ({ matches: true })
    };

    installThemeBoot(fakeDoc as unknown as Document, fakeWin as unknown as Window);

    expect(fakeDoc.documentElement.dataset.theme).toBe('nexus-dark');
  });
});
