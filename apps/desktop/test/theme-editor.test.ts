// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  THEME_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 主题窗口的真机接线：从设置页的入口开窗 → 只读态 → 复制并开始编辑 → 两档编辑器。
 *
 * renderer 层的分支（只读态、token 搜索、对比度体检）在
 * `renderer/test/theme-editor.test.tsx` 与 `theme-window.test.tsx` 里；这里只证明**真实链路
 * 喂进来也是那个结果** —— 窗口真的建出来、只读态真的出现、覆盖项真的写进 CSS 变量、预览里的
 * CodeMirror 真的建起来了、改完设置窗口真的跟着变。
 *
 * 三个窗口跑同一份产物，所以驱动之前要先 `attachToWindow()` 切过去。**一个文件只启动一次
 * Electron**（同文件第二次启动会卡在 `Runtime.enable` 不返回，见 `.workbuddy-ai/memory/MEMORY.md`），
 * 所以整条交互链塞进同一个用例。
 */

/** 取色器的值只能通过原生 setter + `input` 事件改 —— React 的 `onChange` 挂在那上面。 */
const SET_COLOUR = (selector: string, value: string): string => `
  (() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`;

/**
 * 文本输入框同上，但要多一步失焦 —— 主题名走 blur 提交，少了它不会写盘。
 * `blur()` 只对**当前聚焦**的元素派发 `focusout`，所以必须先 `focus()`：对没聚焦的输入框
 * 调 `blur()` 是空操作，事件根本不会发出去。
 */
const SET_TEXT = (selector: string, value: string): string => `
  (() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.blur();
    return 'ok';
  })()
`;

/**
 * 粘贴框是多行文本，原型链上取的是 `HTMLTextAreaElement` —— 用 `HTMLInputElement` 那份 setter
 * 会直接抛 `Illegal invocation`。其余同 `SET_TEXT`。
 */
const SET_TEXTAREA = (selector: string, value: string): string => `
  (() => {
    const area = document.querySelector(${JSON.stringify(selector)});
    if (!area) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, ${JSON.stringify(value)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`;

/** 一段浅色 base16。`base00` 取 `#fafafa` —— 断言拿它当靶子，与主题里原有的值不撞。 */
const PASTE_LIGHT = `system: "base16"
name: "Pasted Light"
variant: "light"
palette:
  base00: "#fafafa"
  base01: "#f0f0f0"
  base02: "#dcdcdc"
  base03: "#a0a0a0"
  base04: "#707070"
  base05: "#303030"
  base06: "#202020"
  base07: "#101010"
  base08: "#c03030"
  base09: "#b06000"
  base0A: "#a08000"
  base0B: "#308030"
  base0C: "#208090"
  base0D: "#2050b0"
  base0E: "#8030a0"
  base0F: "#704020"
`;

const CSS_VAR = (name: string): string =>
  `getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`;

describe('主题窗口', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-theme-window-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n正文。\n', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('从设置页开窗、只读态复制、两档调参写进 CSS 变量、关窗不影响设置窗口', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);

    // ① 设置页里**不再内嵌编辑器**，只有一条通往主题窗口的入口行
    await app.waitForSelector('[data-theme-open-window]', 10000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-theme-editor]')`)).toBe(false);
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-theme-seed]')`)).toBe(false);

    const builtInId = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);
    // 预设卡片上挂的是**族名**（`nexus`），`builtInId` 是解析结果（`nexus-light`）—— 两轴模型下
    // 它们是两个不同的东西，切回去要点前者。
    const builtInPreset = builtInId.replace(/-(light|dark)$/, '');

    // ② 入口行把主题窗口开出来，并切过去
    await app.click('[data-theme-open-window]');
    await app.waitForPageCount(THEME_WINDOW_URL_MARKER, 1, 10000);
    await app.attachToWindow(THEME_WINDOW_URL_MARKER);
    await app.waitForSelector('[data-theme-editor]', 10000);

    // ③ 当前是内置主题 → **只读态**：一个控件都不画，给说明与「复制并开始编辑」
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-theme-readonly]')`)).toBe(
      true
    );
    expect(await app.evaluate<number>(`document.querySelectorAll('[data-theme-seed]').length`)).toBe(
      0
    );

    // ④ 复制并开始编辑：造出副本、切过去、编辑器出现
    await app.click('[data-theme-fork]');
    await app.waitForSelector('[data-theme-tier-panel="basic"]', 10000);

    const userThemeId = await app.evaluate<string>(`document.documentElement.dataset.theme`);
    expect(userThemeId.startsWith('user:')).toBe(true);
    expect(userThemeId).not.toBe(builtInId);

    // ⑤ 基础档：16 个取色器 + 5 个滑块，预览里的 CodeMirror 是真视图，右栏有体检面板
    expect(await app.evaluate<number>(`document.querySelectorAll('[data-theme-seed]').length`)).toBe(
      16
    );
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-theme-tuning]').length`)
    ).toBe(5);
    expect(
      await app.evaluate<boolean>(`!!document.querySelector('[data-theme-preview-code] .cm-editor')`)
    ).toBe(true);
    expect(
      await app.evaluate<boolean>(`!!document.querySelector('[data-theme-contrast-panel]')`)
    ).toBe(true);
    // 两栏：控件在左、结果在右。被折成一栏就等于没从设置页搬出来。
    expect(
      await app.evaluate<boolean>(
        `!!document.querySelector('.nexus-theme-inputs [data-theme-seed-group]') && !!document.querySelector('.nexus-theme-results [data-theme-preview]')`
      )
    ).toBe(true);

    // ⑥ 改一个种子：派生重跑，CSS 变量与存档一起变
    expect(await app.evaluate<string>(SET_COLOUR('[data-theme-seed="base00"]', '#101010'))).toBe(
      'ok'
    );
    await app.waitForFunction(
      `() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-bg-canvas').trim() === '#101010'`,
      10000
    );

    const saved = JSON.parse(
      (await app.evaluate<string>(`localStorage.getItem('nexus-user-theme') ?? ''`)) || '{}'
    ) as { themes?: { id?: string; variants?: { light?: { palette?: Record<string, string> } } }[] };
    // 存档是**列表**（用户可以有多套自定义主题），这里只有一套。
    expect(saved.themes).toHaveLength(1);
    expect(saved.themes?.[0]?.id).toBe(userThemeId);
    expect(saved.themes?.[0]?.variants?.light?.palette?.base00).toBe('#101010');

    // ⑦ 高级档：44 个 token 行，搜索能把它过滤成子集
    await app.click('[data-theme-tier="advanced"]');
    await app.waitForSelector('[data-theme-tier-panel="advanced"]', 10000);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-theme-token]').length`)
    ).toBe(44);

    // 搜索框也是 `<input>`，同一个原生 setter 就能驱动它。
    expect(
      await app.evaluate<string>(SET_COLOUR('[data-theme-token-search]', 'syntax-heading'))
    ).toBe('ok');
    await app.waitForFunction(
      `() => document.querySelectorAll('[data-theme-token]').length === 1`,
      10000
    );
    await app.waitForFunction(
      `() => !!document.querySelector('[data-theme-token="syntax-heading"]')`,
      10000
    );
    // 清掉过滤，后面的步骤要在完整列表上做
    await app.evaluate<string>(SET_COLOUR('[data-theme-token-search]', ''));
    await app.waitForFunction(
      `() => document.querySelectorAll('[data-theme-token]').length === 44`,
      10000
    );

    // ⑧ 覆盖项真的落在 CSS 变量上，而不是只改了 React 状态
    expect(
      await app.evaluate<string>(SET_COLOUR('[data-theme-token-input="bg-surface"]', '#202020'))
    ).toBe('ok');
    await app.waitForFunction(
      `() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-bg-surface').trim() === '#202020'`,
      10000
    );
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-token="bg-surface"]').getAttribute('data-overridden')`
      )
    ).toBe('true');
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-token="bg-surface"] [data-token-state]').getAttribute('data-token-state')`
      )
    ).toBe('overridden');

    // ⑨ 切回基础档：覆盖项提示条必须还在（高级档动过的项不能静默消失）
    await app.click('[data-theme-tier="basic"]');
    await app.waitForSelector('[data-theme-tier-panel="basic"]', 10000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-override-banner]')?.getAttribute('data-override-banner') ?? ''`
      )
    ).toBe('1');

    // ⑩ 提示条上的「全部清除」把覆盖项清干净
    await app.click('[data-override-clear-all]');
    await app.waitForFunction(`() => !document.querySelector('[data-override-banner]')`, 10000);
    expect(await app.evaluate<string>(CSS_VAR('--nexus-bg-surface'))).not.toBe('#202020');

    // ⑪ 主题名可以改：源条是个输入框（名字从源复制过来，fork 不改 name），blur 之后写进存档
    const nameBefore = await app.evaluate<string>(
      `document.querySelector('[data-theme-name-input]')?.value ?? ''`
    );
    expect(nameBefore).not.toBe('');

    expect(await app.evaluate<string>(SET_TEXT('[data-theme-name-input]', '我的主题'))).toBe('ok');
    await app.waitForFunction(
      `() => JSON.parse(localStorage.getItem('nexus-user-theme') || '{}').themes?.[0]?.variants?.light?.name === '我的主题'`,
      10000
    );
    // 改名不该动到主题本身 —— 它换的是标签，不是配色。
    expect(await app.evaluate<string>(CSS_VAR('--nexus-bg-canvas'))).toBe('#101010');

    // ⑫ 明暗两版：源条上的切换器换的是**同一套主题的另一版**，id 不变
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-theme-variant]').length`)
    ).toBe(2);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-variant="light"]')?.getAttribute('aria-checked') ?? ''`
      )
    ).toBe('true');

    await app.click('[data-theme-variant="dark"]');
    await app.waitForFunction(
      `() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-bg-canvas').trim() !== '#101010'`,
      10000
    );
    // 改深色不动浅色：存档里浅色那版还是刚才那个值，选择换成 `@dark`，而 `data-theme` 仍是同一个 id。
    expect(
      await app.evaluate<string>(
        `(() => {
          const saved = JSON.parse(localStorage.getItem('nexus-user-theme') || '{}');
          const theme = saved.themes?.[0] ?? {};
          return JSON.stringify({
            light: theme.variants?.light?.palette?.base00,
            hasDark: !!theme.variants?.dark,
            choice: localStorage.getItem('nexus-theme'),
            dom: document.documentElement.dataset.theme
          });
        })()`
      )
    ).toBe(
      JSON.stringify({
        light: '#101010',
        hasDark: true,
        choice: `${userThemeId}@dark`,
        dom: userThemeId
      })
    );

    // 切回浅色：浅色那一版还是原值 —— 两版是各自独立的快照，改深色没有波及它。
    // 也把应用留在浅色上，后面第 ⑮ 步的期望值才不用跟着这条变。
    await app.click('[data-theme-variant="light"]');
    await app.waitForFunction(
      `() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-bg-canvas').trim() === '#101010'`,
      10000
    );
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-theme')`)).toBe(
      `${userThemeId}@light`
    );

    // ⑬ Escape 只关掉主题窗口，设置窗口还在 —— 两个窗口是兄弟，不是父子
    await app.dispatchKey('Escape');
    await app.waitForPageCount(THEME_WINDOW_URL_MARKER, 0, 10000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(true);

    // ⑭ 跨窗口同步：在主题窗口里的改动，设置窗口也看到了
    //
    // 判据必须带上**模式**：用户主题的明暗两版共用同一个 id，只等 `dataset.theme` 的话，
    // 「还停在深色」也能让这条通过 —— 而下一步点预设卡片读的正是当前模式，会跟着错一档。
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(userThemeId)} &&
             localStorage.getItem('nexus-theme') === ${JSON.stringify(`${userThemeId}@light`)}`,
      10000
    );
    expect(
      await app.evaluate<number>(
        `Array.from(document.querySelectorAll('[data-theme-option]')).filter((el) => el.getAttribute('data-theme-option').startsWith('user:')).length`
      )
    ).toBe(1);
    // ⑪ 里改的名字要在设置页那份列表上看得见 —— 两处读的是同一个 `scheme.name`。
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-option^="user:"]')?.textContent ?? ''`
      )
    ).toContain('我的主题');

    // ⑮ 粘贴 base16：粘进导入 / 导出区那个文本框，点「应用」，CSS 变量当场换。
    // 走的不是文件导入那条路 —— 那个换一整套主题，这个把配色填进**当前这套**。
    // 主题窗口在第 ⑬ 步已经关了，所以这里验的是设置页那一份粘贴框（两处共用同一个组件）。
    expect(await app.evaluate<string>(SET_TEXTAREA('[data-theme-paste-input]', PASTE_LIGHT))).toBe(
      'ok'
    );
    await app.click('[data-theme-paste-apply]');
    await app.waitForFunction(
      `() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-bg-canvas').trim() === '#fafafa'`,
      10000
    );
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-paste-status]')?.getAttribute('data-status') ?? ''`
      )
    ).toBe('ok');

    // ⑯ 设置窗口仍能把主题切回内置预设，主窗口跟着走
    await app.click(`[data-theme-option="${builtInPreset}"]`);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(builtInId)}`,
      10000
    );
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(true);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(builtInId)}`,
      10000
    );
  }, 120000);
});
