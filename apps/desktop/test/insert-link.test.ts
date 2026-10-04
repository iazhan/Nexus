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

/** CDP `Input.dispatchMouseEvent` 的修饰键位掩码（与 `copy-link.test.ts` 同源）。 */
const CTRL = 2;

/**
 * 「插入链接」（P1-2）的真机闭环。
 *
 * 这一批补的是**从光标处写出一条链接**，而它有一条只有真机能走完的链：
 *
 *   Ctrl+Alt+K（宿主 keydown 分发）→ 面板取索引 → 挑一篇 → `buildDocumentLink`（core，写）
 *   → `session.dispatch` → 编辑器重投影 → **Ctrl+点击那条链接** → 打开那一篇
 *
 * 拆开看每一段都有单测（`packages/editor/test/insert-text.test.ts`、
 * `packages/editor/test/link-format-roundtrip.test.ts`），但**接起来能不能用**是另一回事：
 * 单测里「解析」用的是同一个进程、同一份内存，而且选区是手喂的；真机上选区来自真实
 * 编辑器的光标，面板是 React 受控输入，写回去还要过一次 session → view 的同步。
 *
 * 三条只有真机能证的东西：
 *
 * 1. **`Ctrl+Alt+K` 真的被宿主收到了**，而不是被 CodeMirror 的 keymap 吞掉
 *    （`keymaps.ts` 记着 `Mod-M` / `Mod-I` 两次同样的坑）。
 * 2. **选中文字真的成了链接文字**：断言 source 逐字等于 `[[dma|here]]` ——
 *    只断言「source 变了」的话，把选中那段吞掉换成 `[[dma]]` 照样绿。
 * 3. **写出来的那条链接点得开**：`[[dma|here]]` 里的别名不能让解析器找不到目标。
 *
 * `window.alert` 必须换掉：Electron 里它是**原生模态**，一弹出来渲染进程就卡死，
 * CDP 再也回不来。
 */
describe('插入链接（Ctrl+Alt+K → 选目标 → 写进正文 → 点开）', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  const DEEP_SOURCE = '# 深一层\n\nsee here\n';

  beforeAll(() => {
    tempDir = createTempDir('nexus-insert-link-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'notes', 'dma.md'), '# DMA\n\n正文。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'deep.md'), DEEP_SOURCE, 'utf-8');
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
    await waitForFilename(app, name);
  }

  /**
   * 等标题栏变成某篇文档。
   *
   * 不用 harness 的 `waitForFunction`：它把表达式包成同步函数，返回 Promise 的表达式恒为真。
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

  /** 把光标选到 `needle` 这个词上（按内容找位置，不硬编码偏移）。 */
  async function selectWord(app: ElectronAppInstance, needle: string): Promise<void> {
    const ok = await app.evaluate<boolean>(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('window.nexusActiveView 不存在');
      const source = view.state.doc.toString();
      const at = source.indexOf(${JSON.stringify(needle)});
      if (at < 0) throw new Error('正文里找不到 ' + ${JSON.stringify(needle)});
      view.dispatch({ selection: { anchor: at, head: at + ${needle.length} } });
      view.focus();
      return true;
    })()`);
    expect(ok).toBe(true);
  }

  /** 往受控输入框里打字。必须走原型上的 setter —— React 自己装了 value 追踪器。 */
  async function typeInPalette(app: ElectronAppInstance, value: string): Promise<void> {
    await app.evaluate(`(() => {
      const el = document.querySelector('.nexus-insert-link-input');
      if (!el) throw new Error('插入链接面板的输入框不在');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  /**
   * 派一次 keydown，**起点是编辑器的 `contentDOM`**（`.cm-content`），让它先过一遍
   * CodeMirror 的 keymap 再冒泡到宿主。
   *
   * 这就是 harness 的 `dispatchKey`（直接派到 `window`）不够用的地方：派到 `window` 时
   * CM 根本看不见这个事件，于是「宿主收到了」恒成立 —— 而真正要证的是
   * **CM 没有把它吞掉**。`keymaps.ts` 上记着两次同样的坑（`Ctrl-M` / `Mod-I`）：
   * CM 的 keymap 挂在 `contentDOM` 上先跑，匹配上就 `preventDefault()`，
   * 宿主的监听器开头那句 `if (e.defaultPrevented) return;` 让它再也收不到。
   */
  async function dispatchKeyThroughEditor(
    app: ElectronAppInstance,
    key: string,
    modifiers?: { ctrl?: boolean; alt?: boolean }
  ): Promise<void> {
    await app.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      if (!content) throw new Error('.cm-content 不在（编辑器没起来？）');
      content.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        ctrlKey: ${Boolean(modifiers?.ctrl)},
        altKey: ${Boolean(modifiers?.alt)},
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`);
  }

  /**
   * 在面板**内部**派一次按键。
   *
   * 不能用 `app.dispatchKey`（派到 `window`）：React 17 起把监听挂在**根容器**上，
   * 派到 `window` 的事件根本走不到 React 的合成事件系统，面板上的 `onKeyDown` 永远不触发。
   * 派在输入框上才会冒泡到根容器。
   */
  async function pressInPalette(app: ElectronAppInstance, key: string): Promise<void> {
    await app.evaluate(`(() => {
      const el = document.querySelector('.nexus-insert-link-input');
      if (!el) throw new Error('插入链接面板的输入框不在');
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`);
  }

  /** 轮询等一个元素消失。`waitForSelector` 只能等出现。 */
  async function waitForGone(
    app: ElectronAppInstance,
    selector: string,
    timeoutMs = 5000
  ): Promise<void> {
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

  const paletteItems = (app: ElectronAppInstance) =>
    app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('[data-insert-link-item]')).map((el) => el.getAttribute('data-insert-link-item'))`
    );

  /**
   * 确保当前 surface 是 Visual；已经是就不动。
   *
   * 链接跳转只在 Visual 面生效（`.cm-visual-wikilink` 是那一面画出来的）。
   */
  async function ensureVisualSurface(app: ElectronAppInstance): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === 'visual') return;
    await app.click('[data-action="toggle-surface"]');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
  }

  it('选中一段文字 → Ctrl+Alt+K → 挑一篇 → 写进正文 → Ctrl+点击跳过去', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'deep.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    // 原生模态会卡死渲染进程；换掉并记账
    await app.evaluate(`(() => {
      window.__insertLinkAlerts = [];
      window.alert = (message) => { window.__insertLinkAlerts.push(String(message)); };
    })()`);

    await selectWord(app, 'here');

    /* ── ① 快捷键穿过编辑器的 keymap 之后仍被宿主收到，面板浮出 ── */
    await dispatchKeyThroughEditor(app, 'k', { ctrl: true, alt: true });
    await app.waitForSelector('[data-insert-link-palette]', 10000);

    // 候选来自索引：两篇都在（`deep.md` 自己也在，插自己的链接是合法的）
    expect(await paletteItems(app)).toEqual(
      expect.arrayContaining(['notes/dma.md', 'notes/deep.md'])
    );

    /* ── ② 打字过滤 → 回车挑中第一篇 ── */
    await typeInPalette(app, 'dma');
    const filtered = await paletteItems(app);
    expect(filtered).toEqual(['notes/dma.md']);

    await pressInPalette(app, 'Enter');
    await waitForGone(app, '[data-insert-link-palette]');

    /* ── ③ 写出来的是链接，链接文字是**选中的那一段** ── */
    const source = await app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`);
    expect(source).toBe('# 深一层\n\nsee [[dma|here]]\n');
    // 全程不该弹过告警
    expect(await app.evaluate<string[]>(`window.__insertLinkAlerts`)).toEqual([]);

    /* ── ④ 闭环的「读」那一半：点得开 ── */
    await ensureVisualSurface(app);
    await app.mouseClick('.cm-visual-wikilink', CTRL);
    await waitForFilename(app, 'dma.md');
  }, INDEXED_TEST_TIMEOUT_MS);

  it('反面：没选中文字时插入的是**目标文档标题**，不吞掉任何正文', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openRow(app, 'deep.md');
    await app.waitForSelector('.nexus-editor-toolbar', 10000);

    await app.evaluate(`(() => {
      window.__insertLinkAlerts = [];
      window.alert = (message) => { window.__insertLinkAlerts.push(String(message)); };
    })()`);

    // 光标落在文末，没有选区
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end, head: end } });
      view.focus();
      return true;
    })()`);

    await dispatchKeyThroughEditor(app, 'k', { ctrl: true, alt: true });
    await app.waitForSelector('[data-insert-link-palette]', 10000);
    await typeInPalette(app, 'dma');
    await pressInPalette(app, 'Enter');
    await waitForGone(app, '[data-insert-link-palette]');

    // 默认档是 wikilink、没有别名 ⇒ `[[dma]]`，插在文末；原正文逐字不变
    expect(await app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`)).toBe(
      `${DEEP_SOURCE}[[dma]]`
    );
    expect(await app.evaluate<string[]>(`window.__insertLinkAlerts`)).toEqual([]);
  }, INDEXED_TEST_TIMEOUT_MS);
});
