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

/** CDP `Input.dispatchMouseEvent` 的修饰键位掩码（与 `link-navigation-new-file.test.ts` 同源）。 */
const CTRL = 2;

/**
 * 「复制链接」（工作区树右键）的真机接线。
 *
 * 这一批的实质产出就是这一个动作，而它有一条**只有真机能走完**的闭环：
 *
 *   `buildDocumentLink`（core，写）→ `clipboard.writeText`（主进程）→ **真实剪贴板** →
 *   粘回正文 → `marked` 解析 → `resolveRelativePath` / `resolveWikiLink`（读）→ 打开那一篇
 *
 * 拆开看每一段都有单测（`packages/core/test/link-format.test.ts`、
 * `packages/editor/test/link-format-roundtrip.test.ts`），但**接起来能不能用**是另一回事：
 * 单测里「解析」用的是同一个进程、同一份内存；真机上中间还隔着一次 IPC 与一次系统剪贴板。
 *
 * 三条只有真机能证的东西：
 *
 * 1. **写出去的字符串真的进了系统剪贴板**，而不是「`copyText` 返回了 `true`」。
 * 2. **两种格式的相对基准真的是两个不同的东西**（提案 §4.2）：Markdown 链接相对**当前文档目录**，
 *    wikilink 的路径段相对**工作区根**。写错基准的后果是「链接指向别处且不报错」——
 *    这种错在单测里只要两边用同一个错误基准就照样绿，只有真机从树里复制、再 Ctrl+点击过去才暴露。
 * 3. **跨窗口改设置 → 主窗口按新值行事**：`notifySettingsChanged` 是空载荷广播，收方各读各的存档。
 *
 * **一个文件只启动一次 Electron**（同文件第二次启动会卡在 `Runtime.enable` 不返回），
 * 所以四档写法塞进同一个用例。
 *
 * `window.alert` 必须换掉：Electron 里它是**原生模态**，一弹出来渲染进程就卡死，CDP 再也回不来。
 * 顺带把调用记下来 —— 「只弹过一次、而且是该弹的那一次」本身就是一条断言。
 */
describe('复制链接（工作区树右键）', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-copy-link-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'root.md'), '# 根文档\n\n正文。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'dma.md'), '# DMA\n\n正文。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'deep.md'), '# 深一层\n\n正文。\n', 'utf-8');
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
   * 换个工作区形状就变了，而「我点的是 dma.md」这件事不该跟着变。
   */
  async function dispatchOnRow(
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

  /** 右键某一行 → 点菜单里的「复制链接」→ 等回执或等告警。菜单自己会关掉。 */
  async function copyLinkFromTree(app: ElectronAppInstance, name: string): Promise<void> {
    await dispatchOnRow(app, name, 'contextmenu');
    await app.waitForSelector('.nexus-context-menu', 10000);
    await app.click('[data-context-menu-item="copy-link"]');
  }

  /**
   * 读**真实**剪贴板。
   *
   * 从渲染进程读，因为 `copyText` 只有「写」这一半，主进程没开读的口子（也不该为了测试开一个）。
   * 应用没装 `setPermissionRequestHandler`，Electron 默认放行 `clipboard-read`；
   * 窗口没有系统焦点时 `readText()` 会抛 `NotAllowedError`，所以先 `window.focus()`。
   *
   * **异常原样抛出来**，不吞成空串 —— 吞掉的话断言会退化成「空 === 空」而永远绿。
   */
  async function readClipboard(app: ElectronAppInstance): Promise<string> {
    return app.evaluate<string>(`(async () => {
      window.focus();
      return await navigator.clipboard.readText();
    })()`);
  }

  /**
   * 把剪贴板预置成一个哨兵值。
   *
   * 有它，「复制成功」这条断言才成立：否则剪贴板里可能还留着**上一次**的内容，
   * 而那一次的内容恰好与这一次期望的相同 —— 一个失败的复制会被读成成功。
   */
  async function primeClipboard(app: ElectronAppInstance, value: string): Promise<void> {
    await app.evaluate(`window.nexus.copyText(${JSON.stringify(value)})`);
    expect(await readClipboard(app)).toBe(value);
  }

  /**
   * 走**真设置窗口**改链接格式，再回主窗口。
   *
   * 不往 localStorage 里塞值：这样顺带验了「跨窗口改设置 → 主窗口按新值行事」。
   * `App.tsx` 是在**点菜单那一刻**读设置的，所以不需要重启应用。
   */
  async function setLinkFormat(app: ElectronAppInstance, value: string): Promise<void> {
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);
    // 设置窗口会重开在上一次的分组，所以必须显式点进 files
    await app.click('.nexus-settings-nav [data-section="files"]');
    await app.waitForSelector(`[data-field-option="files.linkFormat:${value}"]`, 10000);
    await app.click(`[data-field-option="files.linkFormat:${value}"]`);
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-field-option="files.linkFormat:${value}"]')
          ?.getAttribute('aria-checked') === 'true'`
      )
    ).toBe(true);

    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-tree-scroll', 10000);
  }

  /**
   * 确保当前 surface 是目标；已经是就不动（多切一次会改变滚动等状态）。
   *
   * 链接跳转只在 Visual 面生效（`.cm-visual-link` 是那一面画出来的），
   * 所以闭环的最后一步必须先切过去。
   */
  async function ensureVisualSurface(app: ElectronAppInstance): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === 'visual') return;
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
  }

  /**
   * 打开树上某一行，并等标题栏跟上。
   *
   * 「哪一篇是活动文档」是下面每一条断言的基准（它决定 Markdown 档的相对基准），
   * 所以每一次都要确认到位再往下走。
   */
  async function openRow(app: ElectronAppInstance, name: string): Promise<void> {
    await dispatchOnRow(app, name, 'click');
    await waitForFilename(app, name);
  }

  /**
   * 等标题栏变成某篇文档。
   *
   * 不用 harness 的 `waitForFunction`：它把表达式包成同步函数，返回 Promise 的表达式恒为真、
   * 立刻通过。所以自己轮询 —— `evaluate` 带 `awaitPromise: true`。
   */
  async function waitForFilename(app: ElectronAppInstance, name: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const current = await app.evaluate<string>(
        `document.querySelector('.nexus-filename')?.textContent ?? ''`
      );
      if (current === name) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const current = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    throw new Error(`标题栏没有变成 ${name}（当前是 ${current}）`);
  }

  /**
   * 把一段文本粘进当前文档，切到 Visual，Ctrl+点击它，断言打开的是哪一篇。
   *
   * 这是闭环的「读」那一半。**粘进来的就是刚读出来的真实剪贴板内容** ——
   * 中间不重新拼一遍，否则验的还是 `buildDocumentLink`，而不是「它写出去的东西能不能被读回来」。
   *
   * 选择器要同时收 `cm-visual-wikilink`：wikilink 与 Markdown 链接是**两种不同的装饰**
   * （`link-navigation.ts` 的 `LINK_SELECTOR`），只挑前者的话 ④⑤ 两条会「找不到元素」而失败，
   * 报出来的错跟「链接写错了」长得一模一样。
   */
  async function pasteAndFollow(
    app: ElectronAppInstance,
    pasted: string,
    expectedDocument: string
  ): Promise<void> {
    await app.setSource(`# 链接闭环\n\n${pasted}\n`);
    await ensureVisualSurface(app);
    await app.mouseClick('.cm-visual-link, .cm-visual-wikilink', CTRL);
    await waitForFilename(app, expectedDocument);
  }

  it('四档写法都能从树里复制、粘回正文、Ctrl+点击跳过去', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    // 三篇都在树上。用 `arrayContaining` 而不是逐位比对：排序规则（大小写、区域）会变，
    // 而「这三行在不在」才是这条用例的前提。
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-tree-name')).map((el) => el.textContent)`
      )
    ).toEqual(expect.arrayContaining(['notes', 'dma.md', 'deep.md', 'root.md']));

    // 原生模态会卡死渲染进程；换掉并记账
    await app.evaluate(`(() => {
      window.__copyLinkAlerts = [];
      window.alert = (message) => { window.__copyLinkAlerts.push(String(message)); };
    })()`);

    const alerts = () =>
      app.evaluate<string[]>(`window.__copyLinkAlerts`);
    const noticeText = () =>
      app.evaluate<string>(
        `document.querySelector('[data-copy-link-notice]')?.textContent ?? ''`
      );

    /* ── ① 还没打开任何文档 + Markdown 档 ⇒ 写不出来，而且要说出来 ──
       先切到 Markdown 档再验这一格：默认档（wikilink）**不需要**当前文档，
       拿它验的话这一格根本走不到失败分支。 */
    await setLinkFormat(app, 'markdown');

    await primeClipboard(app, '__sentinel__');
    await copyLinkFromTree(app, 'dma.md');

    const failures = await alerts();
    // 不锁具体措辞（那是 `banner-i18n.test.ts` 的活，而且 locale 会跟着 userData
    // 跨用例残留）。锁的是这条用例自己的不变量：**弹了、弹的是人话、没退化成词典键**。
    expect(failures).toHaveLength(1);
    expect(failures[0]?.length ?? 0).toBeGreaterThan(0);
    expect(failures[0]).not.toContain('workspace.copyLink');
    // 失败时**不留回执**：回执是「事情成了」的记号，跟着失败一起出现会让人以为复制成功了
    expect(await noticeText()).toBe('');
    // 剪贴板没被动过 —— 写不出来就不该写
    expect(await readClipboard(app)).toBe('__sentinel__');

    /* ── ② Markdown 档：基准是**当前文档目录**（root.md 在工作区根） ── */
    await openRow(app, 'root.md');
    await primeClipboard(app, '__sentinel__');
    await copyLinkFromTree(app, 'dma.md');

    expect(await alerts()).toHaveLength(1);
    expect(await noticeText()).toContain('[dma](notes/dma.md)');
    const markdownLink = await readClipboard(app);
    expect(markdownLink).toBe('[dma](notes/dma.md)');

    // 闭环：粘回 root.md → Ctrl+点击 → 打开 notes/dma.md
    await pasteAndFollow(app, markdownLink, 'dma.md');

    /* ── ③ 同一档、换一篇**深一层**的当前文档：基准不同，写法必须跟着变 ──
       这就是提案 §4.2 那条：从 `notes/` 下引用工作区根的文档，路径要带 `../`。
       基准写错（比如两边都用工作区根相对）时 ② 能过、这一格会失败。 */
    await openRow(app, 'deep.md');
    await primeClipboard(app, '__sentinel__');
    await copyLinkFromTree(app, 'root.md');

    const upLevelLink = await readClipboard(app);
    expect(upLevelLink).toBe('[root](../root.md)');
    await pasteAndFollow(app, upLevelLink, 'root.md');

    /* ── ④ wikilink 路径档：路径段是**工作区根相对**，与 ②③ 的基准相反 ── */
    await setLinkFormat(app, 'wikilink-path');
    await openRow(app, 'deep.md');
    await primeClipboard(app, '__sentinel__');
    await copyLinkFromTree(app, 'dma.md');

    const pathWikiLink = await readClipboard(app);
    // 从 `notes/deep.md` 引用 `notes/dma.md`：**没有** `../`，也不该有 —— 基准是工作区根
    expect(pathWikiLink).toBe('[[notes/dma]]');
    await pasteAndFollow(app, pathWikiLink, 'dma.md');

    /* ── ⑤ 默认档：只写名字。同一个目标、同一个当前文档，与 ④ 只差一个设置 ── */
    await setLinkFormat(app, 'wikilink');
    await openRow(app, 'deep.md');
    await primeClipboard(app, '__sentinel__');
    await copyLinkFromTree(app, 'dma.md');

    const nameWikiLink = await readClipboard(app);
    expect(nameWikiLink).toBe('[[dma]]');
    await pasteAndFollow(app, nameWikiLink, 'dma.md');

    /* 全程只该弹过 ① 那一次。多出来的每一条都是「用户没被预先告知就失败了」。 */
    expect(await alerts()).toHaveLength(1);
  }, INDEXED_TEST_TIMEOUT_MS);
});
