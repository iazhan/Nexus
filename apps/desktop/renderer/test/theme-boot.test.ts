import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { THEME_STORAGE_KEY } from '@nexus/theme';
import type { ThemeBootPayload } from '../../ipc/channels.js';

/**
 * 首帧引导。**派生不在这里**（它在主进程，见 `theme-boot.ts` 的头注释），这一层只负责三件事：
 * 把主进程读不到的四个值送过去、把答案落到 DOM 上、答不上来时不要连累整个 bridge。
 *
 * 所以下面每一条都对着其中一件事，没有一条在验「选了什么主题」—— 那是主进程的事，
 * 判据在 `theme-boot-payload` 与 `theme-directory` 两处。
 */

const { sendSync } = vi.hoisted(() => ({ sendSync: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { sendSync } }));

const { installThemeBoot } = await import('../../preload/theme-boot.js');

const STYLE_ID = 'nexus-theme-vars';

const payload = (patch: Partial<ThemeBootPayload> = {}): ThemeBootPayload => ({
  themeId: 'nexus-dark',
  cssText: '',
  themes: [],
  broken: [],
  migrated: true,
  directory: '/home/ada/.nexus/themes',
  ...patch
});

describe('installThemeBoot', () => {
  beforeEach(() => {
    sendSync.mockReset();
    sendSync.mockReturnValue(payload());
    delete document.documentElement.dataset.theme;
    document.getElementById(STYLE_ID)?.remove();
    localStorage.clear();
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    document.getElementById(STYLE_ID)?.remove();
    localStorage.clear();
  });

  it('把主进程算好的 id 写上去，并注入它给的那段 CSS', () => {
    sendSync.mockReturnValue(
      payload({ themeId: 'user:ayu', cssText: ':root {\n  --nexus-accent: #e6b450;\n}\n' })
    );

    installThemeBoot(document, window);

    expect(document.documentElement.dataset.theme).toBe('user:ayu');
    expect(document.getElementById(STYLE_ID)?.textContent).toContain('--nexus-accent: #e6b450;');
  });

  it('内置主题是空串时**不注入** —— 它已经有构建期静态 CSS，再写一份只会多一个变量来源', () => {
    sendSync.mockReturnValue(payload({ themeId: 'nexus-dark', cssText: '' }));

    installThemeBoot(document, window);

    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('请求带上选择、系统偏好、存档原文与迁移标记 —— 这四个主进程都读不到', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    localStorage.setItem('nexus-user-theme', '{"themes":[]}');
    localStorage.setItem('nexus-themes-migrated', '1');

    installThemeBoot(document, window);

    expect(sendSync).toHaveBeenCalledWith('nexus:get-theme-boot', {
      choice: 'dark',
      prefersDark: expect.any(Boolean),
      storedThemes: '{"themes":[]}',
      migrated: true
    });
  });

  it('没有存档时 choice 与 storedThemes 是 null，不是空串', () => {
    installThemeBoot(document, window);

    expect(sendSync).toHaveBeenCalledWith(
      'nexus:get-theme-boot',
      expect.objectContaining({ choice: null, storedThemes: null, migrated: false })
    );
  });

  it('主进程说写出去了才打迁移标记（正面 + 反面：没写成功就不能停读存档）', () => {
    sendSync.mockReturnValue(payload({ migrated: true }));
    installThemeBoot(document, window);
    expect(localStorage.getItem('nexus-themes-migrated')).toBe('1');

    localStorage.clear();
    sendSync.mockReturnValue(payload({ migrated: false }));
    installThemeBoot(document, window);
    expect(localStorage.getItem('nexus-themes-migrated')).toBeNull();
  });

  it('把整份载荷交回调用方 —— 渲染进程还要用它拿目录里的主题列表', () => {
    const boot = payload({ themes: [{ id: 'user:ayu', variants: {} }], broken: [] });
    sendSync.mockReturnValue(boot);

    expect(installThemeBoot(document, window)).toBe(boot);
  });

  it('主进程答不上来时返回 null、不写 data-theme，且**不抛** —— preload 抛错会把整个 bridge 带下去', () => {
    sendSync.mockImplementation(() => {
      throw new Error('no handler');
    });

    expect(installThemeBoot(document, window)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('存储不可用时按「没有存档」走，不抛错', () => {
    const fakeWin = {
      localStorage: {
        getItem(): string {
          throw new Error('storage disabled');
        }
      },
      matchMedia: () => ({ matches: false })
    };

    installThemeBoot(document, fakeWin as unknown as Window);

    expect(sendSync).toHaveBeenCalledWith(
      'nexus:get-theme-boot',
      expect.objectContaining({ choice: null, storedThemes: null, migrated: false })
    );
  });

  it('根元素尚未出现时挂观察者，<html> 出现后再写', () => {
    const callbacks: Array<() => void> = [];
    const fakeDoc = {
      documentElement: null as { dataset: Record<string, string> } | null,
      head: null as { appendChild: (node: unknown) => void } | null,
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' })
    };
    const Original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof MutationObserver;

    try {
      installThemeBoot(fakeDoc as unknown as Document, window);

      // 实测：preload 执行时根元素还不存在，所以走的一定是这条分支。
      expect(callbacks).toHaveLength(1);
      expect(fakeDoc.documentElement).toBeNull();

      fakeDoc.documentElement = { dataset: {} };
      callbacks[0]!();
      expect(fakeDoc.documentElement.dataset.theme).toBe('nexus-dark');
    } finally {
      globalThis.MutationObserver = Original;
    }
  });
});
