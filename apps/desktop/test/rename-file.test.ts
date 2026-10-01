// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 重命名文件（工作区树右键 → 重命名 → 内联输入 → 引用回写）的真机接线。
 *
 * 这一层要证的是**只有真机能证的**几件事：
 *
 * 1. **内联输入框真的拿到焦点、真的能敲进去**。`window.prompt` 在 Electron 里不可用，
 *    所以这是自画的 —— happy-dom 那层只能证明「回调接了线」，证明不了真窗口里
 *    敲回车能提交。
 * 2. **改名真的落到磁盘**，而且四件事一起发生：文件改名、正文回写、历史目录搬迁、
 *    索引那一行就地更新（树/标签页跟着走）。
 * 3. **被回写的文档如果是打开着的，界面不该报「被外部修改」** —— 那次改动正是我们刚做的。
 *    这一格只有真机能验：它取决于 watcher 与主进程写盘之间的先后。
 * 4. **附件走同一条路**（D6）。附件的引用写法是 `![](...)`，与 `[[...]]` 完全是两套规则，
 *    而附件行在侧栏的另一段里 —— 两处都可能「只做了一半」。
 *
 * **一个文件只启动一次 Electron**（同文件第二次启动会卡在 `Runtime.enable` 不返回）。
 * 所以笔记与附件两轮塞进同一个用例。
 *
 * `window.alert` 必须换掉：Electron 里它是**原生模态**，一旦弹出来渲染进程就卡死，
 * CDP 再也回不来。顺带把调用记下来 —— 「一次都没弹」本身就是一条断言。
 */
describe('重命名文件与引用回写', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  /** 3×2 的真实 PNG（与 `p3-09-attachments.test.ts` 同一份 fixture）。 */
  const PNG_3X2 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAIElEQVR42gXBAQEAAAiAIOc4pznN' +
      '6akBYIMdBmuzdmsPcJUKM5Hl0f8AAAAASUVORK5CYII=',
    'base64'
  );

  const rootBefore = '# 根文档\n\n链接到 [[dma]]。\n\n![logo](assets/logo.png)\n';

  function historyDir(relativePath: string): string {
    return path.join(workspace, '.nexus', 'history', ...relativePath.split('/'));
  }

  beforeAll(() => {
    tempDir = createTempDir('nexus-rename-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'root.md'), rootBefore, 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'dma.md'), '# DMA\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'assets', 'logo.png'), PNG_3X2);

    // 历史按相对路径组织。改名后不搬目录的话「可回退」这条路自己就断了，
    // 所以这里铺一份，专门验它跟着走。
    const dir = historyDir('notes/dma.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20260101T000000-aaaaaaaa.md'), '# 旧版本\n', 'utf-8');
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
   * 在树上（含附件区）找到某一行的**行内**派发一个鼠标事件。
   *
   * 按名字找而不是按顺序找：顺序取决于目录展开与排序，换个工作区形状就变了，
   * 而「我点的是 dma.md」这件事不该跟着变。
   */
  async function dispatchOnRow(
    app: ElectronAppInstance,
    name: string,
    type: 'click' | 'contextmenu'
  ): Promise<void> {
    await app.evaluate(`(() => {
      const rows = Array.from(
        document.querySelectorAll('.nexus-tree-file, .nexus-attachment-item')
      );
      const row = rows.find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
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

  /**
   * 轮询到条件成立。
   *
   * **不能**用 harness 的 `waitForFunction`：它把表达式包成同步函数，返回 Promise 的表达式
   * 恒为真、立刻通过（等待变空转）。所以这里自己轮询 —— `evaluate` 带 `awaitPromise: true`。
   */
  async function waitFor(
    app: ElectronAppInstance,
    expression: string,
    what: string,
    timeoutMs = 15000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const done = await app.evaluate<boolean>(`Boolean(${expression})`);
      if (done) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待超时：${what}`);
  }

  /**
   * 在某一行的行内右键并打开菜单，返回菜单项的 id。
   *
   * 菜单项的读取必须在**点任何一项之前** —— 点完菜单自己就关了，那时再查只会拿到空数组。
   */
  async function openRowMenu(app: ElectronAppInstance, name: string): Promise<string[]> {
    await dispatchOnRow(app, name, 'contextmenu');
    await app.waitForSelector('.nexus-context-menu', 10000);
    return app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-context-menu-item]'))
        .map((el) => el.dataset.contextMenuItem)`
    );
  }

  /** 点菜单里的「重命名」，等内联输入框出现，返回它的初值（应带扩展名）。 */
  async function startRename(app: ElectronAppInstance): Promise<string> {
    await app.click('[data-context-menu-item="rename"]');
    await app.waitForSelector('.nexus-tree-rename-input', 10000);
    return app.evaluate<string>(`document.querySelector('.nexus-tree-rename-input')?.value ?? ''`);
  }

  /**
   * 在输入框里改值并敲回车。
   *
   * 用原生 `value` setter 再派发 `input`：React 的受控输入只认这条路，
   * 直接改 `el.value` 不会触发 `onChange`，`draft` 还是旧值 —— 回车提交的是原名，
   * 于是整个流程静默变成「什么都没发生」。
   */
  async function commitInlineRename(app: ElectronAppInstance, newName: string): Promise<void> {
    await app.evaluate(`(() => {
      const input = document.querySelector('.nexus-tree-rename-input');
      if (!input) throw new Error('内联输入框不在');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(newName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true
      }));
    })()`);
  }

  it('笔记与附件都能改名：回写引用、搬历史、更新索引，且不报「被外部修改」', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    // 两段都在：笔记树里有 notes/dma.md，附件区里有 assets/logo.png
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-tree-name')).map((el) => el.textContent)`
      )
    ).toEqual(expect.arrayContaining(['notes', 'dma.md', 'root.md', 'logo.png']));

    // 打开 root.md：它是**被回写的那一篇**，所以这一格验的是「回写之后界面不乱报冲突」
    await dispatchOnRow(app, 'root.md', 'click');
    await app.waitForSelector('.cm-content', 20000);
    await waitFor(
      app,
      `document.querySelector('.nexus-filename')?.textContent === 'root.md'`,
      '标题栏显示 root.md'
    );

    // 原生模态会卡死渲染进程；换掉并记账
    await app.evaluate(`(() => {
      window.__renameAlerts = [];
      window.alert = (message) => { window.__renameAlerts.push(String(message)); };
    })()`);

    /* ── 第一轮：笔记。有引用要改，所以先弹确认屏 ── */
    // 菜单里两项，顺序与 `fileMenuItems` 一致
    expect(await openRowMenu(app, 'dma.md')).toEqual(['rename', 'delete']);
    // 输入框的初值是**带扩展名**的完整文件名：改名不是格式转换，扩展名固定
    expect(await startRename(app)).toBe('dma.md');

    await commitInlineRename(app, 'dma2.md');
    await app.waitForSelector('#nexus-rename-preview', 15000);

    // 确认屏要摆出「改了谁的什么」：文件名 + 那一行的旧写法与新写法
    expect(await app.evaluate<string>(`document.querySelector('.nexus-rename-file')?.textContent ?? ''`)).toBe(
      'root.md'
    );
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-rename-diff > li'))
          .map((el) => el.querySelector('.nexus-diff-text')?.textContent ?? '')`
      )
    ).toEqual(['链接到 [[dma]]。', '链接到 [[dma2]]。']);

    await app.click('[data-rename-confirm]');
    await waitFor(
      app,
      `!!document.querySelector('.nexus-tree-rename-input') === false &&
       Array.from(document.querySelectorAll('.nexus-tree-name')).some((el) => el.textContent === 'dma2.md')`,
      '树显示 dma2.md'
    );

    // ① 磁盘上真的改了名
    expect(fs.existsSync(path.join(workspace, 'notes', 'dma.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'notes', 'dma2.md'))).toBe(true);
    // ② 正文里的引用跟着改（改的是写法，不是语义）
    expect(fs.readFileSync(path.join(workspace, 'root.md'), 'utf-8')).toContain('[[dma2]]');
    expect(fs.readFileSync(path.join(workspace, 'root.md'), 'utf-8')).not.toContain('[[dma]]');
    // ③ 历史目录搬过去了 —— 不搬的话这篇文档的「可回退」就断了
    expect(fs.existsSync(historyDir('notes/dma2.md'))).toBe(true);
    expect(fs.existsSync(historyDir('notes/dma.md'))).toBe(false);

    /* ④ 打开着的 root.md 被回写了，界面必须跟着换内容，而不是报「被外部修改」。
         那两个横幅都出现过一次就说明收尾漏了（`external-changed` 是自动重载没跟上，
         `deleted` 是旧 watcher 把我们自己的改名当成了删除）。 */
    await waitFor(
      app,
      `document.querySelector('.cm-content')?.textContent?.includes('[[dma2]]') === true`,
      '编辑器里显示新链接'
    );
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-conflict-banner')`)).toBe(
      false
    );
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-warning-banner')`)).toBe(
      false
    );

    /* ── 第二轮：附件（D6）。引用写法是 `![](...)`，与 `[[...]]` 完全两套规则 ── */
    expect(await openRowMenu(app, 'logo.png')).toEqual(['rename', 'delete']);
    expect(await startRename(app)).toBe('logo.png');
    await commitInlineRename(app, 'logo2.png');
    await app.waitForSelector('#nexus-rename-preview', 15000);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-rename-diff > li'))
          .map((el) => el.querySelector('.nexus-diff-text')?.textContent ?? '')`
      )
    ).toEqual(['![logo](assets/logo.png)', '![logo](assets/logo2.png)']);

    await app.click('[data-rename-confirm]');
    await waitFor(
      app,
      `Array.from(document.querySelectorAll('.nexus-tree-name')).some((el) => el.textContent === 'logo2.png')`,
      '附件区显示 logo2.png'
    );

    expect(fs.existsSync(path.join(workspace, 'assets', 'logo.png'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'assets', 'logo2.png'))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'root.md'), 'utf-8')).toContain(
      '![logo](assets/logo2.png)'
    );

    // 两轮都不该弹过任何原生提示：没有跳过项，就没有要交代的
    expect(await app.evaluate<string[]>(`window.__renameAlerts`)).toEqual([]);
  }, INDEXED_TEST_TIMEOUT_MS);
});
