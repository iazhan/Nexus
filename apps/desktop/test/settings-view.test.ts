// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 设置视图的真机接线（P4-03）。
 *
 * renderer 层的分支（七组空态 / 键盘 / 三态选中）在 `renderer/test/settings-view.test.tsx` 里；
 * 这里只证明**真实链路喂进来也是那个结果** —— 活动栏按钮不再开命令面板、视图真的替换了中间三栏、
 * 三态真的改 `data-theme`、Escape 能回来。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条交互链塞进同一个用例。
 */
describe('设置视图', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-settings-');
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

  it('活动栏打开设置页、七组齐备、三态生效、Escape 返回', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(
      false
    );

    // ① 活动栏的设置按钮打开设置页。改之前它是假接线 —— 点开的是命令面板。
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.waitForSelector('.nexus-settings-view', 10000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-command-palette')`)).toBe(
      false
    );

    // ② 替换的是中间三栏：活动栏消失，标题栏与状态栏保留
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(
      false
    );
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-header-bar')`)).toBe(true);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-status-bar')`)).toBe(true);

    // ③ 左栏七组齐备，六组是 planned
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

    // ④ 三态可选：选一个与当前解析结果不同的主题，`data-theme` 立刻跟着变并落盘
    const resolved = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);
    const target = resolved === 'nexus-dark' ? 'nexus-light' : 'nexus-dark';
    await app.click(`[data-theme-option="${target}"]`);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(target)}`,
      10000
    );
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-theme') ?? ''`)).toBe(target);

    // ⑤ Escape 返回工作区
    await app.pressKey('Escape');
    await app.waitForFunction(`() => !document.querySelector('.nexus-settings-view')`, 10000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(true);

    // ⑥ 第三个入口：命令面板那条命令的快捷键 `Mod-,`（注册表里带 shortcut，由统一的
    //    快捷键循环分发，不在 handleKeyDown 里另写分支）。
    await app.pressKey(',', { ctrl: true });
    await app.waitForSelector('.nexus-settings-view', 10000);
    await app.pressKey('Escape');
    await app.waitForFunction(`() => !document.querySelector('.nexus-settings-view')`, 10000);
  }, 120000);
});
