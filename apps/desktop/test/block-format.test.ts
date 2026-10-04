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
 * 块级改型（P1-1）的真机闭环。
 *
 * 这一批的动作入口有**三个**：菜单栏的「格式」菜单、`/` 面板（P2-2），
 * 以及常驻工具栏（2026-10-04）。三条链上各有一段只有真机能走完：
 *
 *   点「格式」→ 菜单展开 → 挑一项 → 宿主命令 → `view.state.doc` → 事务 → dispatch → 重投影
 *   敲 `/h2` → 补全面板 → Enter → 宿主删查询串 → 同一条命令 → 同上
 *   点工具栏按钮 → 宿主 `runCommand` → 同一条命令 → 同上
 *
 * 拆开看每一段都有单测（`packages/editor/test/block-format.test.ts`、
 * `apps/desktop/renderer/test/block-format-menu.test.tsx`），但接起来能不能用是另一回事：
 * 单测里选区是手喂的、菜单是喂进去的 props；真机上选区来自真实编辑器，菜单要开、要点，
 * 而且**点菜单会让编辑器失焦** —— 事务读的是 `view.state` 而不是 DOM 选区，这条只有真机能证。
 *
 * 四条只有真机能证的东西：
 *
 * 1. **点完菜单之后落点仍然是对的**：失焦会丢 DOM 选区，若哪一层改成了读 DOM，
 *    表现就是「点了没反应」或「改错行」。
 * 2. **✓ 说的是真话**：断言第二次打开菜单时那一项带 ✓，且再点一次真的回退了 ——
 *    菜单上的勾与事务的行为出自同一个表达式，这条链只有连起来才验得了。
 * 3. **代码块里只剩一项可点**：断言 DOM 上真的 `disabled`，不是只在 props 里禁了。
 * 4. **工具栏按钮不抢焦点**（`mouseClick` 走的是真 CDP 鼠标序列，`mousedown` 是真的）：
 *    happy-dom 里那条「按下会抢焦点」的默认动作要自己演（见 `editor-toolbar.test.tsx`），
 *    真机上它才真的会发生。这条走 `mouseClick` 而不是 `click` 就是为了它。
 *
 * 锚点一律走命令 id（`data-menu-item` / `data-context-menu-item` / `data-action`），
 * **不按文案找** —— 文案跟着语言变，按文字找的用例在切语言时会集体失联。
 */

describe('块级改型（格式菜单 → 改型 → 回退）', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  const SOURCE = '第一段\n\n第二段\n\n```\ncode\n```\n';

  beforeAll(() => {
    tempDir = createTempDir('nexus-block-format-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'doc.md'), SOURCE, 'utf-8');
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

  /** 在树上找到某一行的**行内**派发一次左键（按名字找，不依赖排序）。 */
  async function openRow(app: ElectronAppInstance, name: string): Promise<void> {
    await app.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.nexus-tree-file'))
        .find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('树上找不到 ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 80, view: window }));
    })()`);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const current = await app.evaluate<string>(
        `document.querySelector('.nexus-filename')?.textContent ?? ''`
      );
      if (current === name) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`标题栏没有变成 ${name}`);
  }

  /** 把光标放到 `offset`（无选区）。走 view 而不是 DOM —— CM 的选区是 state 里的。 */
  async function setCaret(app: ElectronAppInstance, offset: number): Promise<void> {
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('window.nexusActiveView 不存在');
      view.dispatch({ selection: { anchor: ${offset}, head: ${offset} } });
      view.focus();
      return true;
    })()`);
  }

  async function waitForGone(app: ElectronAppInstance, selector: string, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await app.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`
      );
      if (!found) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待超时：${selector} 一直没消失`);
  }

  async function openFormatMenu(app: ElectronAppInstance): Promise<void> {
    await app.evaluate(`(() => {
      const button = document.querySelector('[data-menu="format"] .nexus-menu-bar-button');
      if (!button) throw new Error('菜单栏里找不到「格式」');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await app.waitForSelector('[data-menu="format"] .nexus-menu-dropdown', 5000);
  }

  /** 点菜单里某一项。**先等菜单真的收起来** —— 不等的话下一次点按钮会被判成「再按一次关掉」。 */
  async function clickMenuItem(app: ElectronAppInstance, commandId: string): Promise<void> {
    await app.evaluate(`(() => {
      const item = document.querySelector('[data-menu-item=${JSON.stringify(commandId)}]');
      if (!item) throw new Error('「格式」里找不到 ' + ${JSON.stringify(commandId)});
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await waitForGone(app, '[data-menu="format"] .nexus-menu-dropdown');
  }

  const source = (app: ElectronAppInstance) =>
    app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`);

  /**
   * 带 ✓ 的项，按命令 id 返回。
   *
   * **不按文案断言** —— 真机跑的是英文界面（`en-US`），而 `✓` 本身与语言无关。
   */
  const markedItems = (app: ElectronAppInstance) =>
    app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-menu="format"] .nexus-menu-item'))
        .filter((el) => el.querySelector('.nexus-menu-item-label')?.textContent?.startsWith('✓'))
        .map((el) => el.getAttribute('data-menu-item'))`
    );

  const enabledItems = (app: ElectronAppInstance) =>
    app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-menu="format"] .nexus-menu-item:not([disabled])')).map((el) => el.getAttribute('data-menu-item'))`
    );

  it('光标在第一段 → 格式 → 标题 2 → 只有那一行被改，再点一次回退', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    await setCaret(app, 1);
    await openFormatMenu(app);
    await clickMenuItem(app, 'format.heading-2');

    // 断言整篇 source 逐字 —— 只断言「变了」的话，改错行、改错级别都照样绿。
    expect(await source(app)).toBe('## 第一段\n\n第二段\n\n```\ncode\n```\n');

    /* ── ✓ 说的是真话：再打开一次，有且只有那一项带 ✓ ── */
    await openFormatMenu(app);
    expect(await markedItems(app)).toEqual(['format.heading-2']);

    /* ── 再点一次同一项 → 回退到正文（不是又加一层 `## `）── */
    await clickMenuItem(app, 'format.heading-2');
    expect(await source(app)).toBe(SOURCE);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('引用是容器：在标题上点引用得到 `> ## …`，而不是把标题换掉', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    await setCaret(app, 1);
    await openFormatMenu(app);
    await clickMenuItem(app, 'format.heading-2');

    await setCaret(app, 1);
    await openFormatMenu(app);
    expect(await markedItems(app)).toEqual(['format.heading-2']);

    await clickMenuItem(app, 'format.quote');
    expect(await source(app)).toBe('> ## 第一段\n\n第二段\n\n```\ncode\n```\n');

    /* ── 容器与叶块类型正交：再打开时两项都该带 ✓ ── */
    await setCaret(app, 3);
    await openFormatMenu(app);
    expect(await markedItems(app)).toEqual(['format.heading-2', 'format.quote']);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('反面：光标在代码块里时只剩「代码块」可点，点它是拆围栏', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    // `code` 那一行（见 SOURCE 的偏移）
    await setCaret(app, 15);
    await openFormatMenu(app);

    expect(await enabledItems(app)).toEqual(['format.code-block']);

    await clickMenuItem(app, 'format.code-block');
    expect(await source(app)).toBe('第一段\n\n第二段\n\ncode\n');
  }, INDEXED_TEST_TIMEOUT_MS);

  it('source 面同样可用 —— 块级动作不依赖 visual 投影（§7.5）', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    // 切到 source 面。已经是 source 就不动 —— 默认档随设置项走，不写死。
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current !== 'source') {
      await app.click('[data-action="toggle-surface"]');
      await app.waitForSelector('[data-surface-kind="source"]', 20000);
    }

    await setCaret(app, 1);
    await openFormatMenu(app);
    await clickMenuItem(app, 'format.bullet-list');

    expect(await source(app)).toBe('- 第一段\n\n第二段\n\n```\ncode\n```\n');
  }, INDEXED_TEST_TIMEOUT_MS);

  /**
   * `/` 面板（P2-2）。
   *
   * 这条链上只有真机能走完的那一段是**补全插件本身**：面板要真的开出来、`Enter` 要真的
   * 被 `completionKeymap` 接住、接受之后要真的把「命令 id + `/查询` 的范围」递到宿主。
   * 拆开看每一段都有单测（`packages/editor/test/editor-state.test.ts` 管匹配，
   * `renderer/test/slash-commands.test.ts` 管宿主做了什么），但接起来是另一回事。
   *
   * **判据取结果文档，不取面板里的文案** —— 真机跑的是 `en-US`，按文字断言会在切语言时失联。
   * 结果与上面那条菜单用例逐字相同，这本身就是「两处同源」的证据。
   */
  it('`/` 面板：敲 `/h2` 选中一项，落点与「格式」菜单一致', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    // 在文档开头敲下 `/h2`。`userEvent: 'input.type'` 不能省：补全面板按它激活，
    // 少了它这一段只是「改了文档」，面板根本不开 —— 那样这条用例会绿得毫无意义。
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      view.dispatch({
        changes: { from: 0, to: 0, insert: '/h2' },
        selection: { anchor: 3, head: 3 },
        userEvent: 'input.type'
      });
      view.focus();
      return true;
    })()`);

    await app.waitForSelector('.cm-tooltip-autocomplete', 10000);

    // 触发词是英文，所以 `/h2` 在中文界面下也只剩一条 —— 这里数条数，不读文案。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-tooltip-autocomplete li').length`)
    ).toBe(1);

    // 等过 `completionConfig.interactionDelay`（默认 75ms）再回车。
    // `acceptCompletion` 会拒绝「面板刚开就按下的 Enter」—— 那是防误触的，不是 bug，
    // 而这里从输入到回车只隔了两次 CDP 往返（几十毫秒），不等就会被它挡掉，
    // 症状是「回车没接受补全、反而换了一行」。
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 回车接受，等价于手点一项（`completionKeymap` 挂在 `Prec.highest`）。
    await app.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      if (!content) throw new Error('找不到 .cm-content');
      content.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      return true;
    })()`);

    await waitForGone(app, '.cm-tooltip-autocomplete');
    expect(await source(app)).toBe('## 第一段\n\n第二段\n\n```\ncode\n```\n');
  }, INDEXED_TEST_TIMEOUT_MS);

  /**
   * 常驻工具栏（2026-10-04）。第三个入口，同一条命令。
   *
   * 结果与上面那条菜单用例**逐字相同** —— 那本身就是「两处同源」的证据。
   *
   * 走 `mouseClick`（真 CDP 鼠标序列）而不是 `click`：只有真的 `mousedown` 才能验
   * 「按钮不抢编辑器焦点」这条 —— 焦点一丢，事务读到的选区就是空的，
   * 表现成「点了没反应」。用 `click` 的话这条链根本没被走过，用例绿得没有意义。
   */
  it('常驻工具栏：标题下拉改型，落点与「格式」菜单逐字一致', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'doc.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    await setCaret(app, 1);

    const headingPressed = () =>
      app.evaluate<string | null>(
        `document.querySelector('[data-action="format.heading"]')?.getAttribute('aria-pressed') ?? null`
      );
    const headingLit = () =>
      app.evaluate<boolean>(
        `document.querySelector('[data-action="format.heading"]')?.classList.contains('nexus-toolbar-button-on') ?? false`
      );

    // 改型之前：光标在正文上，标题按钮不该亮
    expect(await headingPressed()).toBe('false');

    await app.mouseClick('[data-action="format.heading"]');
    await app.waitForSelector('.nexus-context-menu', 5000);

    // 7 项 + 1 条分组线（正文与标题之间）
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-context-menu-item]').length`)
    ).toBe(7);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-context-menu-separator').length`)
    ).toBe(1);

    // ✓ 落在「正文」上（与菜单栏那份同一个 `blockFormatState`）
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-context-menu-checkable]'))
          .filter((el) => el.getAttribute('aria-checked') === 'true')
          .map((el) => el.getAttribute('data-context-menu-item'))`
      )
    ).toEqual(['format.paragraph']);

    await app.mouseClick('[data-context-menu-item="format.heading-2"]');
    await waitForGone(app, '.nexus-context-menu');

    expect(await source(app)).toBe('## 第一段\n\n第二段\n\n```\ncode\n```\n');

    // 按下态跟着变：现在光标所在块是标题，按钮该亮；视觉与 `aria-pressed` 同源
    expect(await headingPressed()).toBe('true');
    expect(await headingLit()).toBe(true);

    // 直接按钮（不走下拉）：引用是容器，加在标题之外
    await app.mouseClick('[data-action="format.quote"]');
    expect(await source(app)).toBe('> ## 第一段\n\n第二段\n\n```\ncode\n```\n');
  }, INDEXED_TEST_TIMEOUT_MS);
});