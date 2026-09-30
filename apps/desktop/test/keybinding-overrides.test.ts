// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 快捷键覆盖的**真行为**：改绑定 → 落盘 → 订阅 → 分发。
 *
 * 三条只有真机能证的：
 *
 * 1. **覆盖项真的驱动分发**。renderer 层能测到「设置页写进了 store」，测不到「宿主按下去
 *    用的是新值」—— 分发循环读的是 `resolveShortcut`，跟控件之间隔着订阅链与一整个 effect。
 * 2. **编辑器真的把 `Mod-F` / `Mod-H` 让给了宿主**。判据必须是「改绑之后旧键不再开面板」：
 *    编辑器还绑着它的话，CodeMirror 会先消费并 `preventDefault()`，面板照样会开 ——
 *    只断言「新键能开面板」两种实现都通过。
 * 3. **跨进程广播**。设置窗口与主窗口各有一份 `SettingsStore`，覆盖表要经过主进程中转才能到
 *    对面；`keybindingTable()` 又按引用缓存，对面少一次重解析就是「设置窗口改了、主窗口照旧」。
 *
 * **一个文件只启动一次 Electron**（同文件多次启动会卡死），所以三条用例共用一次启动。
 */
describe('快捷键覆盖', () => {
  let tempDir: string;
  let app: ElectronAppInstance;

  /** 归零。Electron 的 user-data-dir 没按用例隔离，每条用例都得自己显式归位。 */
  const RESET = `window.nexusSettings.set('keybindings.overrides', {})`;

  const SURFACE_KIND = `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`;
  const HAS_SEARCH = `Boolean(document.querySelector('.cm-search'))`;
  const CLOSE_SEARCH = `(() => {
    const button = document.querySelector('.cm-search button[name=close]');
    if (button) button.click();
    return true;
  })()`;

  /**
   * 派发到**编辑器内部**。宿主监听器挂在 `window` 上，事件从 `.cm-content` 冒泡上去 ——
   * 只有这条路径能暴露「CodeMirror 会不会先吃掉这个键」，派发到 `window` 会绕过编辑器。
   */
  function dispatchIntoEditor(
    key: string,
    modifiers: { ctrl?: boolean; shift?: boolean } = {}
  ): string {
    return `(() => {
      const el = document.querySelector('.cm-content');
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        ctrlKey: ${Boolean(modifiers.ctrl)},
        shiftKey: ${Boolean(modifiers.shift)},
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`;
  }

  async function waitForSurface(kind: 'source' | 'visual'): Promise<void> {
    await app.waitForFunction(`() => ${SURFACE_KIND} === ${JSON.stringify(kind)}`, 10000);
  }

  beforeAll(async () => {
    tempDir = createTempDir('nexus-keybinding-overrides-');
    const docPath = path.join(tempDir, 'doc.md');
    fs.writeFileSync(docPath, '# 标题\n\n正文一行。\n', 'utf-8');
    app = await launchElectronApp({ filePath: docPath });
    await app.waitForSelector('.cm-content', 20000);
    await app.evaluate(RESET);
  }, 120000);

  afterAll(async () => {
    if (app) {
      await app.evaluate(`localStorage.removeItem('nexus-keybindings')`);
      await app.close();
    }
  });

  it('覆盖项驱动分发：新键生效、旧键失效', async () => {
    await app.evaluate(RESET);

    // 默认绑定先走一遍，证明这条链路本来是通的（否则下面的「旧键失效」可能只是整条都坏了）。
    await app.dispatchKey('m', { ctrl: true });
    await waitForSurface('visual');
    await app.dispatchKey('m', { ctrl: true });
    await waitForSurface('source');

    // 改绑：`Mod-M` → `Mod-Shift-M`。写盘 + 广播 + 订阅全走真实路径。
    await app.evaluate(
      `window.nexusSettings.set('keybindings.overrides', { 'toggle-surface': 'Mod-Shift-M' })`
    );
    // 存的是**规范形**：单字符键统一小写（`Mod-Shift-M` → `Mod-Shift-m`），
    // 否则 `formatShortcut` 在不同来源写进来的串上会显示成两种样子。
    expect(
      await app.evaluate<Record<string, string>>(
        `window.nexusSettings.get('keybindings.overrides')`
      )
    ).toEqual({ 'toggle-surface': 'Mod-Shift-m' });
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-keybindings') ?? ''`)).toBe(
      '{"toggle-surface":"Mod-Shift-m"}'
    );

    // 旧键失效：按下去什么都不该发生。
    await app.dispatchKey('m', { ctrl: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(await app.evaluate<string | null>(SURFACE_KIND)).toBe('source');

    // 新键生效。
    await app.dispatchKey('m', { ctrl: true, shift: true });
    await waitForSurface('visual');

    await app.evaluate(RESET);
    await app.dispatchKey('m', { ctrl: true });
    await waitForSurface('source');
  }, 60000);

  it('编辑器聚焦时宿主拥有 Mod-F：改绑定后旧键不再开面板', async () => {
    await app.evaluate(RESET);
    await app.evaluate(CLOSE_SEARCH);
    await app.evaluate(`window.nexusActiveView.focus()`);

    // 默认绑定：事件从编辑器内部派发，宿主开面板。
    await app.evaluate(dispatchIntoEditor('f', { ctrl: true }));
    await app.waitForSelector('.cm-search', 10000);

    // 改绑到 `Mod-Shift-F`，再归零。
    await app.evaluate(
      `window.nexusSettings.set('keybindings.overrides', { find: 'Mod-Shift-F' })`
    );
    await app.evaluate(CLOSE_SEARCH);
    await app.evaluate(`window.nexusActiveView.focus()`);

    // **这条是「编辑器让出 Mod-F」的判据**：编辑器还绑着它的话，CodeMirror 会先消费掉并
    // `preventDefault()`，宿主看到 `defaultPrevented` 就返回，面板仍会被编辑器自己打开。
    await app.evaluate(dispatchIntoEditor('f', { ctrl: true }));
    await new Promise((r) => setTimeout(r, 400));
    expect(await app.evaluate<boolean>(HAS_SEARCH)).toBe(false);

    // 新键生效，且事件同样从编辑器内部派发 —— 证明是宿主接住了，不是编辑器恰好没拦。
    await app.evaluate(dispatchIntoEditor('f', { ctrl: true, shift: true }));
    await app.waitForSelector('.cm-search', 10000);

    await app.evaluate(CLOSE_SEARCH);
    await app.evaluate(RESET);
  }, 60000);

  it('设置窗口改绑定，主窗口按新键生效', async () => {
    await app.evaluate(RESET);

    // 开设置窗口。走 `dispatchKey` 而不是 `pressKey` —— 后者依赖窗口持有系统焦点。
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);

    // 在**设置窗口那个渲染进程**里写覆盖项：落盘 → `onWrite` → 主进程广播 → 主窗口 reload。
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);
    await app.evaluate(
      `window.nexusSettings.set('keybindings.overrides', { 'toggle-surface': 'Mod-Shift-M' })`
    );

    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await waitForSurface('source');

    // 主窗口的 `keybindingTable()` 是按引用缓存的 —— 少了对面那次重解析，这里仍会读旧表。
    await app.dispatchKey('m', { ctrl: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(await app.evaluate<string | null>(SURFACE_KIND)).toBe('source');

    await app.dispatchKey('m', { ctrl: true, shift: true });
    await waitForSurface('visual');

    await app.dispatchKey('m', { ctrl: true, shift: true });
    await waitForSurface('source');
    await app.evaluate(RESET);
  }, 90000);
});
