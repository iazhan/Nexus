// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 删除文件（工作区树右键 → 删除）的真机接线。
 *
 * 这一层要证的是**三件事，各自都只有真机能证**：
 *
 * 1. 右键真的能弹出菜单 —— 树上的行是 `<button>`，菜单是 `position: fixed` 浮在
 *    `overflow-y: auto` 的树容器上面。`context-menu.test.tsx` 测的是菜单自己，
 *    「树上那一行有没有把右键转出来」只有真 DOM 说了算。
 * 2. 删除真的落到磁盘，而且**三处痕迹同时收掉**（标签页 / 索引记录 / 树的列表）。
 *    少一处就会出现「文件没了但树里还在」，或者「树里没了但标签页还开着一个幽灵文档」。
 * 3. **两条分支的差别是真的**：回收站那一档历史留着，永久删除那一档历史一起没。
 *    这正是它们各自自洽的地方 —— 「移到回收站 = 还能找回来」「永久删除 = 什么都不留」。
 *
 * 档位走**真设置窗口**改，而不是往 localStorage 里塞一个值：这样顺带验了
 * 「跨窗口改设置 → 主窗口按新值行事」（`notifySettingsChanged` 是空载荷广播，收方各读各的
 * 存档）。`App.tsx` 是在**点击那一刻**读设置的，所以不需要重启应用。
 *
 * `window.confirm` 必须换掉：Electron 里它是**原生模态**，会把渲染进程卡死，CDP 再也回不来。
 * 换掉之后再点删除，走的才是「用户点了确定」那条路。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以两条分支塞进同一个用例。
 */
describe('删除文件', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  function historyDir(relativePath: string): string {
    return path.join(workspace, '.nexus', 'history', ...relativePath.split('/'));
  }

  /** 铺一份历史快照。两条分支的**差别**就在它留不留上，所以两份都要铺。 */
  function seedHistory(relativePath: string): void {
    const dir = historyDir(relativePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20260101T000000-aaaaaaaa.md'), '# 旧版本\n', 'utf-8');
  }

  beforeAll(() => {
    tempDir = createTempDir('nexus-delete-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'root.md'), '# 根文档\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'dma.md'), '# DMA\n', 'utf-8');
    seedHistory('root.md');
    seedHistory('notes/dma.md');
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

  /**
   * 在树上找到某一行的**行内**派发一个鼠标事件。
   *
   * 按名字找而不是按 `.nexus-tree-file` 的顺序找：顺序取决于目录展开与排序，
   * 换个工作区形状就变了，而「我点的是 root.md」这件事不该跟着变。
   */
  async function dispatchOnTreeRow(
    app: ElectronAppInstance,
    name: string,
    type: 'click' | 'contextmenu'
  ): Promise<void> {
    await app.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.nexus-tree-file'))
        .find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('树上找不到 ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 80,
        view: window
      }));
    })()`);
  }

  /** 右键并等菜单出现。 */
  async function rightClickTreeRow(app: ElectronAppInstance, name: string): Promise<void> {
    await dispatchOnTreeRow(app, name, 'contextmenu');
    await app.waitForSelector('.nexus-context-menu', 10000);
  }

  /**
   * 等某一行从树上消失。
   *
   * **不能**用 harness 的 `waitForFunction`：它把表达式包成同步函数，返回 Promise 的表达式
   * 恒为真、立刻通过（等待变空转）。所以这里自己轮询 —— `evaluate` 带 `awaitPromise: true`。
   */
  async function waitForTreeRowGone(app: ElectronAppInstance, name: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const present = await app.evaluate<boolean>(
        `Array.from(document.querySelectorAll('.nexus-tree-name'))
          .some((el) => el.textContent === ${JSON.stringify(name)})`
      );
      if (!present) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${name} 还在树里 —— 删完没有重读列表`);
  }

  /** 等标题栏显示某个文件名 —— 「打开成标签页」与「标签页被收掉」共用这一个判据。 */
  async function waitForFilename(app: ElectronAppInstance, name: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const current = await app.evaluate<string>(
        `document.querySelector('.nexus-filename')?.textContent ?? ''`
      );
      if (current === name) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`标题栏没有变成 ${name}`);
  }

  it('右键删除：默认走回收站且历史留着；改成永久删除后历史一起没', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    // 顶层目录默认展开，所以 dma.md 也看得见
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-tree-name')).map((el) => el.textContent)`
      )
    ).toEqual(['notes', 'dma.md', 'root.md']);

    /* ① 默认档位（回收站）。开**两个**文档，好验「删完那个标签页也收了」——
       标签栏在只剩一个文档时不渲染（`TabBar` 直接 `return null`），所以只开一个就无从判断。 */
    await dispatchOnTreeRow(app, 'dma.md', 'click');
    await app.waitForSelector('.cm-content', 20000);
    await dispatchOnTreeRow(app, 'root.md', 'click');
    await waitForFilename(app, 'root.md');
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-tab').length`)).toBe(2);

    await rightClickTreeRow(app, 'root.md');
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-context-menu-item]'))
          .map((el) => el.dataset.contextMenuItem)`
      )
    ).toEqual(['delete']);

    // 回收站那一档**不**确认（可逆的操作不该拿弹窗烦人），所以这里不装 confirm 也不会卡住。
    await app.click('[data-context-menu-item="delete"]');
    await waitForTreeRowGone(app, 'root.md');

    expect(fs.existsSync(path.join(workspace, 'root.md'))).toBe(false);
    // 回收站 = 「还能找回来」，所以它的历史**留着**（恢复到同一路径时历史跟着回来）。
    expect(fs.existsSync(historyDir('root.md'))).toBe(true);
    // 三处痕迹之一：被删的那个标签页也收了 —— 焦点落回另一个文档。
    // 少了这一步，用户会留下一个指向已删文件的幽灵标签页。
    await waitForFilename(app, 'dma.md');
    // 菜单自己关掉了，不留在屏幕上
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-context-menu')`)).toBe(
      false
    );

    /* ② 把档位改成「永久删除」—— 走真设置窗口 */
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);
    // 设置窗口会重开在上一次的分组，所以必须显式点进 files
    await app.click('.nexus-settings-nav [data-section="files"]');
    await app.waitForSelector('[data-field-option="files.deleteBehavior:permanent"]', 10000);
    await app.click('[data-field-option="files.deleteBehavior:permanent"]');
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-field-option="files.deleteBehavior:permanent"]')
          ?.getAttribute('aria-checked') === 'true'`
      )
    ).toBe(true);

    // 回主窗口。跨窗口同步是「谁改的谁广播、收方各读各的存档」，所以主窗口会在点删除
    // 那一刻读到新值，不需要重启。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-tree-scroll', 10000);

    // `window.confirm` 是原生模态，不换掉会把渲染进程卡死
    await app.evaluate(`window.confirm = () => true`);

    /* ③ 永久删除：文件与历史一起没 */
    await rightClickTreeRow(app, 'dma.md');
    await app.click('[data-context-menu-item="delete"]');
    await waitForTreeRowGone(app, 'dma.md');

    expect(fs.existsSync(path.join(workspace, 'notes', 'dma.md'))).toBe(false);
    // 永久删除 = 「什么都不留」：留着历史等于留了一份用户以为已经删掉的**内容副本**。
    expect(fs.existsSync(historyDir('notes/dma.md'))).toBe(false);
    // 祖先目录也被收干净（`notes/` 下没有别的文档了）
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history', 'notes'))).toBe(false);
    // 历史根自己不能跟着被收掉，否则下一次保存就找不到父目录
    expect(fs.existsSync(path.join(workspace, '.nexus', 'history'))).toBe(true);
  }, INDEXED_TEST_TIMEOUT_MS);
});
