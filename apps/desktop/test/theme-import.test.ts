// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * base16 导入的真机接线（P4-07 / P4-08）。
 *
 * renderer 层的分支（坏文件 / 缺槽位 / 撤销 / 拖入）在 `renderer/test/theme-transfer.test.tsx`
 * 里；这里只证明**真链路也是那个结果** —— 文件选择框真接了 `change`、导入真的换掉 16 个种子、
 * 真的落盘、撤销真的回得去。
 *
 * 导入用 `DOM.setFileInputFiles` 走**真文件**，不是往 React 状态里塞字符串：「按钮接了、但
 * `<input type="file">` 的 change 没接」这类问题只有真链路能发现。
 *
 * 设置是**独立窗口**，所以驱动之前要先 `attachToWindow()` 切过去。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条链塞进同一个用例。
 */

/** Nord 的种子，逐字取自 tinted-theming 的 `base16/nord.yaml`。 */
const NORD_YAML = `system: "base16"
name: "Nord"
author: "arcticicestudio"
variant: "dark"
palette:
  base00: "#2E3440"
  base01: "#3B4252"
  base02: "#434C5E"
  base03: "#4C566A"
  base04: "#D8DEE9"
  base05: "#E5E9F0"
  base06: "#ECEFF4"
  base07: "#8FBCBB"
  base08: "#BF616A"
  base09: "#D08770"
  base0A: "#EBCB8B"
  base0B: "#A3BE8C"
  base0C: "#88C0D0"
  base0D: "#81A1C1"
  base0E: "#B48EAD"
  base0F: "#5E81AC"
`;

const CSS_VAR = (name: string): string =>
  `getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`;

describe('主题导入', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-theme-import-');
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

  it('导入一份 base16 方案：换掉 16 个种子、立刻切过去、可撤销', async () => {
    const yamlPath = path.join(tempDir, 'nord.yaml');
    fs.writeFileSync(yamlPath, NORD_YAML, 'utf-8');

    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-theme-transfer', 10000);

    const before = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);

    const document = await app.sendCommand<{ root: { nodeId: number } }>('DOM.getDocument');
    const input = await app.sendCommand<{ nodeId: number }>('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '[data-theme-import]'
    });
    expect(input.nodeId).toBeGreaterThan(0);
    await app.sendCommand('DOM.setFileInputFiles', { files: [yamlPath], nodeId: input.nodeId });

    await app.waitForFunction(
      `() => (document.documentElement.dataset.theme ?? '').startsWith('user:')`,
      10000
    );

    // 种子换了：base00 直喂 bg-canvas，所以变量等于文件里的值（且被归一化成小写）
    expect(await app.evaluate<string>(CSS_VAR('--nexus-bg-canvas'))).toBe('#2e3440');

    const saved = JSON.parse(
      (await app.evaluate<string>(`localStorage.getItem('nexus-user-theme') ?? ''`)) || '{}'
    ) as { themes?: { variants?: { dark?: { name?: string; palette?: Record<string, string> } } }[] };
    // Nord 上游只有暗版，所以导入出来的用户主题只有 dark 一边；存档是列表，这里只有一套。
    const theme = saved.themes?.[0];
    expect(saved.themes).toHaveLength(1);
    expect(theme?.variants?.dark?.name).toBe('Nord');
    expect(theme?.variants?.dark?.palette?.base00).toBe('#2e3440');
    expect(theme?.variants?.dark?.palette?.base0D).toBe('#81a1c1');

    // 状态行报的是「已导入」，并且给了撤销入口
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-theme-transfer-status]')?.getAttribute('data-status') ?? ''`
      )
    ).toBe('ok');
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-theme-import-undo]')`)).toBe(
      true
    );

    // 撤销回到导入前的主题
    await app.click('[data-theme-import-undo]');
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(before)}`,
      10000
    );
  }, 120000);
});
