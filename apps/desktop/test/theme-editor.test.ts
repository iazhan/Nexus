// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 两档主题编辑器的真机接线（P4-05 / P4-06）。
 *
 * renderer 层的分支（高级档才有提示条、不达标才标对比度）在
 * `renderer/test/theme-editor.test.tsx` 里；这里只证明**真实链路喂进来也是那个结果** ——
 * 改种子会 fork 出用户主题并落盘、覆盖项真的写进 CSS 变量、预览里的 CodeMirror 真的建起来了。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条交互链塞进同一个用例。
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

const CSS_VAR = (name: string): string =>
  `getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`;

describe('主题编辑器', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-theme-editor-');
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

  it('改种子 fork 出用户主题、高级档覆盖项写进 CSS 变量、切主题能退回去', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.waitForSelector('.nexus-theme-editor', 10000);

    // ① 基础档：16 个取色器 + 5 个滑块，预览里的 CodeMirror 是真视图
    expect(await app.evaluate<number>(`document.querySelectorAll('[data-theme-seed]').length`)).toBe(
      16
    );
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-theme-tuning]').length`)
    ).toBe(5);
    expect(
      await app.evaluate<boolean>(`!!document.querySelector('[data-theme-preview-code] .cm-editor')`)
    ).toBe(true);

    const builtInId = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);

    // ② 改一个种子：内置主题不可写，所以先 fork 出用户主题；派生重跑，CSS 变量跟着变
    expect(await app.evaluate<string>(SET_COLOUR('[data-theme-seed="base00"]', '#101010'))).toBe(
      'ok'
    );
    await app.waitForFunction(
      `() => (document.documentElement.dataset.theme ?? '').startsWith('user:')`,
      10000
    );

    const userThemeId = await app.evaluate<string>(`document.documentElement.dataset.theme`);
    expect(userThemeId).not.toBe(builtInId);
    expect(await app.evaluate<string>(CSS_VAR('--nexus-bg-canvas'))).toBe('#101010');

    const saved = JSON.parse(
      (await app.evaluate<string>(`localStorage.getItem('nexus-user-theme') ?? ''`)) || '{}'
    ) as { id?: string; scheme?: { palette?: Record<string, string> } };
    expect(saved.id).toBe(userThemeId);
    expect(saved.scheme?.palette?.base00).toBe('#101010');

    // ③ 高级档：43 个 token 行
    await app.click('[data-theme-tier="advanced"]');
    await app.waitForSelector('[data-theme-tier-panel="advanced"]', 10000);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-theme-token]').length`)
    ).toBe(43);

    // ④ 覆盖项真的落在 CSS 变量上，而不是只改了 React 状态
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

    // ⑤ 切回基础档：覆盖项提示条必须还在（高级档动过的项不能静默消失）
    await app.click('[data-theme-tier="basic"]');
    await app.waitForSelector('[data-theme-tier-panel="basic"]', 10000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-override-banner]')?.getAttribute('data-override-banner') ?? ''`
      )
    ).toBe('1');

    // ⑥ 提示条上的「全部清除」把覆盖项清干净
    await app.click('[data-override-clear-all]');
    await app.waitForFunction(
      `() => !document.querySelector('[data-override-banner]')`,
      10000
    );
    expect(await app.evaluate<string>(CSS_VAR('--nexus-bg-surface'))).not.toBe('#202020');

    // ⑦ 切回内置主题：用户主题留着，但当前主题与 data-theme 都退回去
    await app.click(`[data-theme-option="${builtInId}"]`);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(builtInId)}`,
      10000
    );
    expect(
      await app.evaluate<string>(`localStorage.getItem('nexus-user-theme') ?? ''`)
    ).not.toBe('');

    // ⑧ Escape 回到工作区
    await app.pressKey('Escape');
    await app.waitForFunction(`() => !document.querySelector('.nexus-settings-view')`, 10000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(true);
  }, 120000);
});
