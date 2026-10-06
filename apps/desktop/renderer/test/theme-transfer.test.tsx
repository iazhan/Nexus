// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CHOICE, parseBase16 } from '@nexus/theme';
import { ThemeTransfer } from '../src/settings/ThemeTransfer.js';
import { exportActiveTheme, importBase16Text } from '../src/settings/theme-transfer.js';
import { applyThemeChoice, settings, themeManager } from '../src/platform.js';

/**
 * base16 导入 / 导出（P4-07 / P4-08）。
 *
 * 这一层必须有的理由：真机用例一个文件只能启动一次 Electron，覆盖不到「坏文件 / 缺槽位 /
 * 撤销」这些分支，而这几条正是导入功能最容易做错的地方。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Dracula 的种子，逐字取自 tinted-theming；顺手塞一个不该被采信的 token 覆盖项。 */
const DRACULA_YAML = `system: "base16"
name: "Dracula"
author: "clach04"
variant: "dark"
palette:
  base00: "#282a36"
  base01: "#21222c"
  base02: "#44475a"
  base03: "#6272a4"
  base04: "#9ea8c7"
  base05: "#f8f8f2"
  base06: "#f8f8f2"
  base07: "#ffffff"
  base08: "#ff5555"
  base09: "#ffb86c"
  base0A: "#f1fa8c"
  base0B: "#50fa7b"
  base0C: "#8be9fd"
  base0D: "#bd93f9"
  base0E: "#ff79c6"
  base0F: "#993333"
tokenColors:
  accent-solid: "#ff0000"
`;

let container: HTMLDivElement;
let root: Root;

function resetTheme(): void {
  settings.set('appearance.userThemes', []);
  applyThemeChoice(DEFAULT_THEME_CHOICE);
}

function renderTransfer(): void {
  act(() => {
    root.render(<ThemeTransfer />);
  });
}

function el<T extends HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

describe('主题导入 · 纯逻辑', () => {
  beforeEach(() => resetTheme());
  afterEach(() => resetTheme());

  it('导入成功后注册、切换、落盘一次到位，并报出修正条数', () => {
    const outcome = importBase16Text(DRACULA_YAML, 'dracula');

    expect(outcome).toMatchObject({ ok: true, name: 'Dracula', variant: 'dark' });
    if (!outcome.ok) return;

    expect(themeManager.theme.id).toBe(outcome.themeId);
    // 一个 base16 文件就是一版配色，所以导入出来的用户主题只有一边，落在它自己的那一版上。
    expect(themeManager.themeChoice).toBe(`${outcome.themeId}@dark`);
    expect(settings.get('appearance.theme')).toBe(`${outcome.themeId}@dark`);
    expect(settings.get('appearance.userThemes').map((theme) => theme.id)).toEqual([
      outcome.themeId
    ]);
    // Dracula 的种子对比度不可控，派生必须真修正过一部分 —— 报 0 说明修正没跑。
    expect(outcome.corrections).toBeGreaterThan(0);
  });

  /**
   * 这一条是 D4 的核心：**导入的是 16 个种子，不是 token**。文件里带的 `tokenColors` 必须被忽略，
   * 45 个 token 全部由派生管线算出来 —— 采信文件里的值等于绕过对比度契约。
   */
  it('文件里的 token 颜色被忽略，token 全部来自派生', () => {
    importBase16Text(DRACULA_YAML, 'dracula');

    const tokens = themeManager.theme.tokens;
    expect(Object.keys(tokens)).toHaveLength(45);
    expect(tokens['accent-solid']).not.toBe('#ff0000');
    // accent-solid 是「压到承白字」的深色，与种子 base0D 不是一回事 —— 它变了就说明派生跑了。
    expect(tokens['accent-solid']).not.toBe('#bd93f9');
  });

  it('解析失败时不切主题、不落盘', () => {
    applyThemeChoice('nexus-light');
    const outcome = importBase16Text('这不是主题文件', 'bad');

    expect(outcome).toMatchObject({ ok: false, error: { code: 'missing-slots' } });
    expect(themeManager.theme.id).toBe('nexus-light');
    expect(settings.get('appearance.userThemes')).toEqual([]);
  });

  it('缺槽位时报出具体槽位名', () => {
    const outcome = importBase16Text(DRACULA_YAML.replace('  base0A: "#f1fa8c"\n', ''), 'bad');

    expect(outcome).toMatchObject({ ok: false, error: { code: 'missing-slots', slots: ['base0A'] } });
  });
});

describe('主题导出 · 纯逻辑', () => {
  beforeEach(() => resetTheme());
  afterEach(() => resetTheme());

  it('导出的 YAML 能被自己读回来，文件名带 slug', () => {
    // `nord` 是不带后缀的那一版方案（暗版），所以文件名就是 `nord.yaml`。
    applyThemeChoice('nord');
    const result = exportActiveTheme('yaml');

    expect(result?.fileName).toBe('nord.yaml');
    const reparsed = parseBase16(result?.text ?? '');
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.scheme.name).toBe('Nord');
      expect(reparsed.scheme.variant).toBe('dark');
    }
  });

  it('JSON 同理，扩展名跟着换', () => {
    applyThemeChoice('nord');
    const result = exportActiveTheme('json');

    expect(result?.fileName).toBe('nord.json');
    expect(parseBase16(result?.text ?? '').ok).toBe(true);
  });

  /** 导出丢覆盖项是**显式**的：base16 只有 16 个槽位，数量要报给 UI，不能静默丢。 */
  it('报出被丢掉的 token 覆盖项数量', () => {
    applyThemeChoice('nord');
    expect(exportActiveTheme()?.droppedOverrides).toBe(0);

    themeManager.forkActiveToUserTheme('user:x');
    themeManager.overrideToken('bg-canvas', '#101010');
    themeManager.overrideToken('bg-surface', '#202020');

    expect(exportActiveTheme()?.droppedOverrides).toBe(2);
  });
});

describe('ThemeTransfer 组件', () => {
  let created: { url: string; blob: Blob }[];
  let downloads: string[];
  let originalClick: typeof HTMLAnchorElement.prototype.click;

  beforeEach(() => {
    resetTheme();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    created = [];
    downloads = [];
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (blob) => {
      const url = `blob:test-${created.length}`;
      created.push({ url, blob });
      return url;
    };
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
    originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      downloads.push(this.getAttribute('download') ?? '');
    };
  });

  afterEach(() => {
    HTMLAnchorElement.prototype.click = originalClick;
    act(() => root.unmount());
    container.remove();
    resetTheme();
  });

  it('渲染导入按钮与两个导出按钮，初始没有状态行', () => {
    renderTransfer();

    expect(el('[data-theme-import-button]')).not.toBeNull();
    expect(el('[data-theme-import]')).not.toBeNull();
    expect(container.querySelectorAll('[data-theme-export]')).toHaveLength(2);
    expect(el('[data-theme-transfer-status]')).toBeNull();
  });

  it('点导出：触发一次下载，状态行报出文件名', async () => {
    applyThemeChoice('nord');
    renderTransfer();

    await act(async () => {
      el<HTMLButtonElement>('[data-theme-export="yaml"]')!.click();
    });

    expect(downloads).toEqual(['nord.yaml']);
    expect(await created[0]?.blob.text()).toContain('name: "Nord"');
    expect(el('[data-theme-transfer-status]')?.getAttribute('data-status')).toBe('ok');
  });

  it('选文件导入：切过去、状态行给撤销入口，撤销回到原主题', async () => {
    applyThemeChoice('nexus@light');
    renderTransfer();

    const input = el<HTMLInputElement>('[data-theme-import]')!;
    const file = new File([DRACULA_YAML], 'dracula.yaml', { type: 'text/yaml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(themeManager.theme.id.startsWith('user:')).toBe(true);
    expect(el('[data-theme-transfer-status]')?.getAttribute('data-status')).toBe('ok');

    await act(async () => {
      el<HTMLButtonElement>('[data-theme-import-undo]')!.click();
    });

    expect(themeManager.theme.id).toBe('nexus-light');
    // 撤销恢复的是**选择**（`<预设>@<模式>`），不是解析出来的方案 id。
    expect(themeManager.themeChoice).toBe('nexus@light');
    expect(el('[data-theme-transfer-status]')).toBeNull();
  });

  /** 文件名去掉扩展名当兜底名字 —— 文件里没写 `name` 时至少有个认得出的标签。 */
  it('文件里没有 name 时用文件名兜底', async () => {
    renderTransfer();
    const input = el<HTMLInputElement>('[data-theme-import]')!;
    const withoutName = DRACULA_YAML.replace(/^name: .*\n/m, '');
    Object.defineProperty(input, 'files', {
      value: [new File([withoutName], 'my-cool-theme.yaml')],
      configurable: true
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(themeManager.activeScheme?.name).toBe('my-cool-theme');
  });

  it('坏文件给出错误状态，且不切主题', async () => {
    applyThemeChoice('nexus-light');
    renderTransfer();
    const input = el<HTMLInputElement>('[data-theme-import]')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['{ "name": "x" }'], 'broken.json')],
      configurable: true
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(el('[data-theme-transfer-status]')?.getAttribute('data-status')).toBe('error');
    expect(themeManager.theme.id).toBe('nexus-light');
  });

  it('拖入文件与选文件走同一条路', async () => {
    renderTransfer();
    const file = new File([DRACULA_YAML], 'dracula.yaml', { type: 'text/yaml' });

    await act(async () => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      el('[data-theme-transfer]')!.dispatchEvent(event);
    });

    expect(themeManager.activeScheme?.name).toBe('Dracula');
  });

  it('拖入时整块标记成投放态，拖离后复原', () => {
    renderTransfer();
    const zone = el('[data-theme-transfer]')!;
    expect(zone.getAttribute('data-drop-active')).toBe('false');

    act(() => {
      zone.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    });
    expect(zone.getAttribute('data-drop-active')).toBe('true');

    act(() => {
      zone.dispatchEvent(new Event('dragleave', { bubbles: true }));
    });
    expect(zone.getAttribute('data-drop-active')).toBe('false');
  });
});
