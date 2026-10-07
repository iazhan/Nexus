// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';
import { RECENT_WORKSPACE_FILE } from '../electron/recent-workspace.js';

/**
 * 「文件 → 打开文件夹… / 打开最近的工作区 ▸」在真机上的那一半。
 *
 * ## 为什么必须真机，而 happy-dom 那批不够
 *
 * `open-workspace-app.test.tsx` 把桥打桩了，验的是「菜单怎么用桥给的东西」；
 * 这一条验的是**桥给的东西从哪来**：`recent-workspace.json` → 主进程读盘 → 过滤掉
 * 已经不存在的目录 → IPC → 渲染进程投影成子菜单。中间任何一环断了，打桩的那批都照样绿。
 *
 * ## 预置 userData 而不是「先开一次工作区」
 *
 * 「打开文件夹…」弹的是原生目录选择框，CDP 进不去；而走桥调 `openWorkspace` 又**不会**
 * 触发渲染进程重新拉列表（那条路径在 `App.handleOpenWorkspace` 里，桥调用绕不过去）。
 * 所以直接**种一份落盘文件**再启动 —— 顺带把「升级后第一次启动能不能读旧形状」
 * 之外的另一件事也盖住了：启动时读的就是这份文件。
 *
 * `restoreLastWorkspace: false` 是刻意的：**不要**让启动回落把某个目录开起来，
 * 这一条要的是裸启动（欢迎态）+ 菜单。它同时保证了主进程模块加载那一步不会回写文件。
 */
describe('最近工作区菜单（真机）', () => {
  let tempDir: string;
  let userDataDir: string;
  let vaultA: string;
  let vaultB: string;
  let gonePath: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-recent-menu-');
    vaultA = path.join(tempDir, 'vault-a');
    vaultB = path.join(tempDir, 'vault-b');
    gonePath = path.join(tempDir, 'vault-gone');
    fs.mkdirSync(vaultA, { recursive: true });
    fs.mkdirSync(vaultB, { recursive: true });
    // `vault-gone` **刻意不建** —— 它要证明「已经不在了的目录会被主进程剔掉」。

    userDataDir = createTempDir('nexus-userdata-menu-');
    fs.writeFileSync(
      path.join(userDataDir, RECENT_WORKSPACE_FILE),
      `${JSON.stringify(
        { restoreLastWorkspace: false, workspaceRoots: [vaultA, gonePath, vaultB] },
        null,
        2
      )}\n`,
      'utf-8'
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('菜单里三条工作区入口都在，最近那一项只列还存在的目录', async () => {
    activeApp = await launchElectronApp({ userDataDir });
    const app = activeApp;

    // 裸启动（`restoreLastWorkspace: false` + 没给路径）⇒ 欢迎态。
    await app.waitForSelector('[data-workspace-open-folder]', 20000);

    // 展开「文件」菜单。点的是 DOM，`evaluate` 不走输入管线，所以不依赖窗口焦点。
    await app.evaluate(`(() => {
      document.querySelector('[data-menu="file"] .nexus-menu-bar-button').click();
      return true;
    })()`);
    await app.waitForSelector('[data-menu="file"] .nexus-menu-dropdown', 5000);

    const ids = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-menu="file"] .nexus-menu-item')).map((el) => el.getAttribute('data-menu-item'))`
    );
    expect(ids).toContain('open-folder');
    expect(ids).toContain('open-recent-workspace');
    expect(ids).toContain('open-in-workspace');

    // 列表非空 ⇒ 那一项可用。列表是挂载后异步拉的，所以这里要等它到位。
    //
    // 判据写成函数而不是 `!el?.disabled` 那样的表达式：元素还不存在时
    // `!undefined` 是 `true`，条件会在菜单还没画出来的时候就直接成立 —— 假绿。
    await app.waitForFunction(
      `() => {
        const el = document.querySelector('[data-menu-item="open-recent-workspace"]');
        return Boolean(el) && !el.disabled;
      }`,
      10000
    );

    await app.evaluate(`(() => {
      document.querySelector('[data-menu-item="open-recent-workspace"]').click();
      return true;
    })()`);
    await app.waitForSelector('.nexus-menu-submenu', 5000);

    const entries = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-menu-submenu .nexus-menu-item-label')).map((el) => el.textContent)`
    );
    // `vault-gone` 不在里面 —— 这是这一条真正的价值：**过滤发生在主进程**，
    // 渲染进程没有 `fs`，它只是照单投影。少了这一环，点一个已经不存在的目录会
    // 「成功」切进一个空工作区（`authorizeWorkspace` 不 stat 目录），而界面不报错。
    expect(entries).toEqual([vaultA, vaultB]);

    // 每一项的 `title` 是完整路径：长路径会被 CSS 截成省略号，截掉的那一半只有这里能补。
    const titles = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-menu-submenu .nexus-menu-item')).map((el) => el.getAttribute('title'))`
    );
    expect(titles).toEqual([vaultA, vaultB]);
  }, 60000);
});
