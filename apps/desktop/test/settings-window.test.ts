// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
 * 设置窗口的真机接线。
 *
 * 三件事只有真机能证：
 *
 * 1. **窗口真的被建出来**（不是主窗口里换了个视图）—— 主窗口里不再有 `.nexus-settings-view`，
 *    设置界面在**另一个 CDP page target** 上。
 * 2. **单例** —— 重复触发不会开出第二个设置窗口。
 * 3. **跨窗口同步** —— 设置窗口改了主题，主窗口的 `data-theme` 跟着变。
 *
 * renderer 层的分支（七组空态 / 键盘 / Escape 的两个分支）在
 * `renderer/test/{settings-view,settings-window}.test.tsx` 里。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条交互链塞进同一个用例。
 */
describe('设置窗口', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-settings-window-');
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

  it('快捷键开窗、结构齐备、主题跨窗口同步、单例、Escape 关窗、关掉后能再开', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);

    // ① 起初只有一个窗口，主窗口里**没有**设置界面
    expect((await app.pageTargets()).length).toBe(1);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(
      false
    );

    // ② `Mod-,` 开出**第二个窗口**
    //    用 `dispatchKey`（DOM 派发）而不是 `pressKey`：后者走 CDP 输入管线、依赖窗口真实
    //    持有系统焦点，无头运行下不可靠。详见 harness 的 `dispatchKey` 注释。
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    expect((await app.pageTargets()).length).toBe(2);
    // 主窗口不受影响：活动栏还在，设置界面没有挤进主窗口
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(
      true
    );
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(
      false
    );

    // ③ 切到设置窗口：它自己是一页，装的是设置本体
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-window-role="settings"]') !== null`
      )
    ).toBe(true);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-settings-nav [data-section]')).map((el) => el.getAttribute('data-section'))`
      )
    ).toEqual(['general', 'editor', 'appearance', 'keybindings', 'plugins', 'sync', 'data']);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-settings-nav [data-availability="planned"]').length`
      )
    ).toBe(6);
    // 独立窗口没有「返回工作区」这个键了 —— 关窗归标题栏与 Escape
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-settings-back]')`)).toBe(
      false
    );

    // ④ 在设置窗口改主题：`data-theme` 立刻变并落盘
    const resolved = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);
    const target = resolved === 'nexus-dark' ? 'nexus-light' : 'nexus-dark';
    await app.click(`[data-theme-option="${target}"]`);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(target)}`,
      10000
    );
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-theme') ?? ''`)).toBe(target);

    // ⑤ 跨窗口同步：切回主窗口，它也换过来了。
    //    这条是独立窗口方案最容易漏的地方 —— 两个渲染进程各有一份 `SettingsStore`，
    //    少了主进程中转就是「设置窗口改了、主窗口纹丝不动」。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(target)}`,
      10000
    );

    // ⑥ 单例：再触发一次不会开出第二个设置窗口。
    //    这里走 `evaluate` 直接调桥、不派发按键 —— 设置窗口持有焦点时主窗口的
    //    `Input.dispatchKeyEvent` 不会被 ack（Chromium 不给非活动页派发输入），
    //    走按键会挂 15s。单例判据与被测的入口无关，用桥更稳。
    await app.evaluate(`window.nexus.openSettingsWindow()`);
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      (await app.pageTargets()).filter((t) => t.url.includes(SETTINGS_WINDOW_URL_MARKER)).length
    ).toBe(1);

    // ⑦ Escape 关掉设置窗口；主窗口不受影响
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.dispatchKey('Escape');
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 0, 10000);
    expect((await app.pageTargets()).length).toBe(1);

    // ⑧ 关掉之后还能再开 —— 单例是「复用开着的那个」，不是「一辈子只开一次」。
    //    这一条走**活动栏按钮**：设置窗口关了之后焦点回到主窗口，点击派得出去。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-activity-icon[data-activity="settings"]', 10000);
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
  }, 120000);
});
