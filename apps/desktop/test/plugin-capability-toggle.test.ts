// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { MATH_EXTENSION_ID, MERMAID_EXTENSION_ID } from '@nexus/editor';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';
import { createPdf } from './fixtures/documents.js';

/**
 * 内置能力启停的真机闭环。
 *
 * 另外三层各自只盖住一半：`extension-host.test.ts` / `viewer-registry.test.tsx` 证明
 * 「谓词一改，查表立刻变」；`settings-view.test.tsx` 证明「开关点下去，存档写对了」；
 * `capability-toggle.test.ts` 证明「投影会重算、widget 会重建」。三层全绿仍然可以出现
 * **用户视角的「点了没反应」** —— 因为跨窗口那条链没人验：设置窗口写盘 → 主进程广播 →
 * 主窗口 `reload()` → 编辑器 / 视图重渲染。这个文件验的就是它。
 *
 * 判据一律取**结构**（widget 里有没有 KaTeX、那张卡是「已禁用」还是「尚未接入」），
 * 不比对文案 —— i18n 的默认语言受 userData 影响，断文案会变成「单跑绿、全跑红」。
 *
 * 两处必须真机才验得到：
 *
 * 1. **跨窗口。** 设置窗口与主窗口是两个渲染进程，中间隔着 localStorage 与主进程广播。
 *    happy-dom 里两个 store 是同一个对象，「另一个窗口改了」是直接调 `set()`。
 * 2. **跨启动。** 这个值只存在渲染进程的 localStorage 里（它**没有**进宿主设置通道，
 *    所以主进程那份 `recent-workspace.json` 里看不到它）。写盘时机由 Chromium 决定，
 *    只能靠真关一次窗口去验。
 */
describe('内置能力启停', () => {
  let tempDir: string;
  let workspace: string;
  let notePath: string;
  let userDataDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-plugin-toggle-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // 一份文档里同时出现两种标记：关掉一个之后，另一个还在不在就是「有没有连累」的判据。
    fs.writeFileSync(
      path.join(workspace, 'both.md'),
      '# 混合\n\n能量 $E = mc^2$ 守恒。\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(workspace, 'doc.pdf'), createPdf(['启停用例']));
    fs.writeFileSync(
      path.join(workspace, 'pic.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )
    );

    // 跨启动那条另开一份单文件，不跟工作区共用 —— 它只验落盘，不需要文件树。
    notePath = path.join(tempDir, 'note.md');
    fs.writeFileSync(notePath, '# 公式\n\n能量 $E = mc^2$ 守恒。\n', 'utf-8');

    // 显式给 userDataDir：harness 只在没传的时候才自建并删掉，传了就是「要跨启动复用」。
    userDataDir = path.join(tempDir, 'userdata');
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

  /** 存档里那份「被关掉的能力」。判据取存档，不取界面文案。 */
  const readDisabled = (app: ElectronAppInstance) =>
    app.evaluate<string>(`localStorage.getItem('nexus-plugins-disabled') ?? ''`);

  /**
   * 按相对路径点文件树里的一行。
   *
   * 用 DOM 派发而不是 `mouseClick`：设置窗口一建出来就抢走系统焦点，此后主窗口上的
   * CDP 输入事件**不返回**（见 harness 的 `attachToWindow` 注释）。`evaluate` 走 JS 执行，
   * 不受这条约束。
   */
  const openByPath = (app: ElectronAppInstance, relativePath: string) =>
    app.evaluate<boolean>(`(() => {
      const row = document.querySelector(${JSON.stringify(
        `.nexus-workspace-sidebar [data-relative-path="${relativePath}"]`
      )});
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);

  /** 切到 Visual。**已经是就不切** —— 多切一次会切回 Source，后面全以「找不到 widget」失败。 */
  async function openVisual(app: ElectronAppInstance): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === 'visual') return;
    await app.click('[data-action="toggle-surface"]');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
  }

  /**
   * 打开（或聚焦）设置窗口并停在插件分组。
   *
   * 走桥而不是 Ctrl+,：多窗口下只有持有系统焦点的那个窗口收得到 CDP 键盘事件，
   * 而设置窗口建出来时会 `focus()`。走 `openSettingsWindow` 顺带也验了「带分组打开」。
   */
  async function openPluginsSettings(app: ElectronAppInstance): Promise<void> {
    await app.evaluate(`window.nexus.openSettingsWindow('plugins')`);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('[data-settings-section="plugins"]', 15000);
  }

  /** 某个成员现在是不是勾着（勾着 ＝ 启用）。 */
  const memberOn = (app: ElectronAppInstance, id: string) =>
    app.evaluate<boolean>(
      `document.querySelector('[data-field-member="plugins.disabled:${id}"]')
         ?.getAttribute('aria-checked') === 'true'`
    );

  /** 拨一下那个成员，并等它真的翻过去。 */
  async function flipMember(app: ElectronAppInstance, id: string): Promise<void> {
    const selector = `[data-field-member="plugins.disabled:${id}"]`;
    const before = await memberOn(app, id);
    await app.click(selector);
    await app.waitForFunction(
      `document.querySelector(${JSON.stringify(selector)})
         ?.getAttribute('aria-checked') === '${String(!before)}'`,
      10000
    );
  }

  /**
   * 回主窗口。多窗口下 CDP 只认当前附着的那一页，断言之前必须切回来。
   *
   * 等的判据是**标题栏**而不是活动栏：活动栏只在工作区模式里画，而跨启动那条用例跑的是
   * 单文件模式（`mode: 'lightweight'`）—— 等活动栏会以「等不到选择器」超时，看起来像
   * 「设置窗口没让出焦点」，其实只是这一页上根本没有那个元素。
   */
  async function backToMain(app: ElectronAppInstance): Promise<void> {
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-header-bar', 15000);
  }

  it('关掉 math：已经渲染出来的公式退回源码、mermaid 照常，且不重启', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    expect(await openByPath(app, 'both.md')).toBe(true);
    await app.waitForSelector('.cm-content', 20000);
    await openVisual(app);
    // 两个扩展都渲染出来，先钉住这个前提 —— 否则后面的「没了」可能是从来没出现过
    await app.waitForSelector('.cm-visual-inline-math .katex', 20000);
    await app.waitForSelector('.cm-mermaid-preview svg', 20000);

    // 哨兵：窗口一旦重载，这个变量就没了。它把「改设置本身不重启应用」变成可断言的。
    await app.evaluate(`(() => { window.__nexusToggleSentinel = 'alive'; return true; })()`);

    await openPluginsSettings(app);
    await flipMember(app, MATH_EXTENSION_ID);
    // 反面（设置页这侧）：关掉 math 时 mermaid 仍勾着 —— 存档是一个整串，
    // 拼错的后果是「关一个连带关掉另一个」。
    expect(await memberOn(app, MERMAID_EXTENSION_ID)).toBe(true);
    await backToMain(app);
    expect(await readDisabled(app)).toBe(MATH_EXTENSION_ID);

    // 公式退回源码。**判据是 KaTeX 没了，不是 widget 没了** —— 那个 span 还在，
    // 它改成画源码文本（`InlineMathWidget.toDOM` 的兜底）。
    await app.waitForFunction(
      `document.querySelectorAll('.cm-visual-inline-math .katex').length === 0`,
      15000
    );
    expect(
      await app.evaluate<string>(`document.querySelector('.cm-visual-inline-math')?.textContent ?? ''`)
    ).toContain('$E = mc^2$');

    // 反面（编辑器这侧）：关掉 math 不能连累 mermaid
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-mermaid-preview svg').length`)
    ).toBe(1);
    // 反面（进程这侧）：哨兵还在，说明渲染进程没换过
    expect(await app.evaluate<string | null>(`window.__nexusToggleSentinel ?? null`)).toBe('alive');

    // 再打开：当场回到渲染态，同样不重启
    await openPluginsSettings(app);
    await flipMember(app, MATH_EXTENSION_ID);
    await backToMain(app);
    expect(await readDisabled(app)).toBe('');
    await app.waitForSelector('.cm-visual-inline-math .katex', 20000);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('关掉 pdf 渲染器：那份 PDF 当场换成「已禁用」卡，图片照常', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    expect(await openByPath(app, 'doc.pdf')).toBe(true);
    await app.waitForSelector('.nexus-pdf-canvas', 30000);
    // 前提：没被关的时候走的是渲染器，不是任何一张卡
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-viewer-disabled').length`)
    ).toBe(0);

    await openPluginsSettings(app);
    await flipMember(app, 'pdf');
    await backToMain(app);

    await app.waitForSelector('.nexus-viewer-disabled[data-viewer-type="pdf"]', 15000);
    // 三张卡各说一件事，判据必须分开：这张说「有，但被你关了」。
    // 画成「当前构建里没有」或「重启试试」都算错，而它们共用同一段兜底代码。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-viewer-placeholder').length`)
    ).toBe(0);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-viewer-unavailable').length`)
    ).toBe(0);

    // 反面：关掉 pdf 不能连累图片 —— 换一份 PNG，照样渲染
    expect(await openByPath(app, 'pic.png')).toBe(true);
    await app.waitForSelector('.nexus-image-content', 20000);
    await app.waitForFunction(
      `(() => {
         const img = document.querySelector('.nexus-image-content');
         return img !== null && img.naturalWidth > 0;
       })()`,
      15000
    );
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-viewer-disabled[data-viewer-type="image"]').length`
      )
    ).toBe(0);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('关掉之后再打开 Nexus：禁用状态还在，公式仍是源码', async () => {
    activeApp = await launchElectronApp({ filePath: notePath, userDataDir });
    let app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    expect(await readDisabled(app)).toBe('');

    await openPluginsSettings(app);
    await flipMember(app, MATH_EXTENSION_ID);
    await backToMain(app);
    expect(await readDisabled(app)).toBe(MATH_EXTENSION_ID);

    // **必须优雅关闭**：这个值只在 localStorage 里，SIGTERM 会让 Chromium 来不及刷盘 ——
    // 症状是「下次启动读回来是空的」，看起来像产品 bug。
    await app.closeGracefully();
    activeApp = null;

    activeApp = await launchElectronApp({ filePath: notePath, userDataDir });
    app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    // 换了一次进程之后还是关着的 —— 这就是落盘的全部意义
    expect(await readDisabled(app)).toBe(MATH_EXTENSION_ID);
    await openVisual(app);
    await app.waitForSelector('.cm-visual-inline-math', 20000);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-visual-inline-math .katex').length`)
    ).toBe(0);
    expect(
      await app.evaluate<string>(`document.querySelector('.cm-visual-inline-math')?.textContent ?? ''`)
    ).toContain('$E = mc^2$');
  }, INDEXED_TEST_TIMEOUT_MS);
});
