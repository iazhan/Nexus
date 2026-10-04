// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 给目录加 / 删「拒绝写入」ACE，用来模拟「目标不可写」的保存失败场景。
 *
 * **必须走异步 `execFile`，不能用 `execFileSync` / `execSync`。**
 * 本机（Windows + 受限执行环境）上 Node 的**同步**进程创建整体不可用：任何 `spawnSync`
 * 都立刻返回 `EBUSY`，与子进程是谁、有没有并发都无关 —— 裸跑
 * `node -e "require('child_process').execFileSync('icacls', ['.'])"` 同样 EBUSY，
 * 而异步 `spawn` / `execFile` 正常（harness 启动 Electron 走的就是异步 `spawn`）。
 * 曾按「瞬时抖动」处理加过退避重试：30s 预算内 98 次尝试全部 EBUSY，证明重试无意义。
 *
 * 直连 `icacls.exe` 而非 `cmd.exe`，顺带省掉一层 shell 与 `*S-1-1-0:(W)` 的引号转义。
 */
async function runIcacls(args: string[]): Promise<void> {
  await execFileAsync('icacls', args, { windowsHide: true });
}

describe('Desktop Smoke Test (P1-04F)', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  /**
   * 共享窗口：给「换内容换断言」的用例复用。
   *
   * 这些用例验的是**编辑器对内容的处理**（渲染、往返编辑、快捷键、扩展按需加载），
   * 与「打开哪个文件」无关 —— 换内容用 `setSource` 就行，不必重开窗口。
   * 重开一次的代价是 Electron 启动 + 索引，约 5 秒。
   *
   * **不适用**于这几类：验启动参数本身的（Lightweight 打开某路径）、
   * 依赖持久化状态的（自动保存 / 冲突 / 只读）、必须重启或关窗的（第 9、10 条）。
   * 它们各自起窗口，用 `activeApp`。
   */
  let sharedApp: ElectronAppInstance | null = null;
  /** 共享窗口打开的那份文档；断言自动保存时要读它 */
  let sharedDocPath = '';

  beforeAll(async () => {
    // Ensure temp dir for test files
    tempDir = createTempDir('nexus-smoke-');

    const sharedDoc = path.join(tempDir, 'shared.md');
    fs.writeFileSync(sharedDoc, '# 占位\n', 'utf-8');
    sharedDocPath = sharedDoc;

    sharedApp = await launchElectronApp({ filePath: sharedDoc });
    await sharedApp.waitForSelector('.cm-content', 20000);
  });

  afterEach(async () => {
    // 只关「自己起的窗口」。共享窗口留给 afterAll，否则下一条用例就没窗口可用了。
    if (activeApp && activeApp !== sharedApp) {
      await activeApp.close();
    }
    activeApp = null;

    // 共享窗口要归零：源码清空、surface 回到 Source。
    // 不复位 surface 的话，上一条停在 Visual，下一条的「切到 Visual」会把它切回 Source。
    if (sharedApp) {
      await sharedApp.setSource('# 占位\n');
      await ensureSurface(sharedApp, 'source');
    }
  });

  afterAll(async () => {
    if (sharedApp) {
      await sharedApp.close();
      sharedApp = null;
    }
  });

  /** 确保当前 surface 是目标；已经是就不动（多切一次会改变滚动等状态）。 */
  async function ensureSurface(app: ElectronAppInstance, target: string): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === target) return;

    await app.click('[data-action="toggle-surface"]');
    await app.waitForSelector(`[data-surface-kind="${target}"]`, 20000);
  }

  it('1. launches a Markdown file into Lightweight Mode within 2s, displaying filename', async () => {
    const testFile = path.join(tempDir, 'sample-launch.md');
    fs.writeFileSync(testFile, '# Hello Nexus Smoke\n\nWelcome to Lightweight Mode.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: testFile });

    // Wait for App and editor content to be ready
    await activeApp.waitForSelector('.cm-content', 15000);

    // 回归：`.nexus-filename` 是共享选择器列表
    // （`.nexus-header-left, …, .nexus-app-title, .nexus-filename, .nexus-filepath-subtitle { … }`）
    // 的一员。曾用正则批量删 CSS 规则时只认到列表最后一项，把整块声明连带删掉，
    // 留下悬空列表把下一条规则（`.nexus-window-controls`）的声明吞并给了整个 header ——
    // 这些元素继承了 display:flex / align-self:stretch，肉眼可见变形。
    // 这种损坏在语法上是合法 CSS，静态检查抓不到，只能断言渲染结果。
    const filenameStyle = await activeApp.evaluate<{
      alignSelf: string;
      textOverflow: string;
    }>(
      `(() => { const cs = getComputedStyle(document.querySelector('.nexus-filename')); return { alignSelf: cs.alignSelf, textOverflow: cs.textOverflow }; })()`
    );
    expect(filenameStyle.alignSelf).not.toBe('stretch');
    expect(filenameStyle.textOverflow).toBe('ellipsis');

    const filename = await activeApp.getText('.nexus-filename');
    expect(filename).toContain('sample-launch.md');

    const editorText = await activeApp.getText('.cm-content');
    expect(editorText).toContain('Hello Nexus Smoke');
  }, 25000);

  it('2. opens files with Chinese path and spaces, preserving UTF-8 encoding', async () => {
    const chineseDir = path.join(tempDir, '中文 目录 with spaces');
    fs.mkdirSync(chineseDir, { recursive: true });
    const chineseFile = path.join(chineseDir, '测试 文档 🎉.md');
    const content = '# 中文标题 🎉\n\n这是包含中文和空格路径的测试文档。\n\n- 项目一\n- 项目二';
    fs.writeFileSync(chineseFile, content, 'utf-8');

    activeApp = await launchElectronApp({ filePath: chineseFile });

    await activeApp.waitForSelector('.cm-content', 15000);
    const filename = await activeApp.getText('.nexus-filename');
    expect(filename).toContain('测试 文档 🎉.md');

    const editorText = await activeApp.getText('.cm-content');
    expect(editorText).toContain('这是包含中文和空格路径的测试文档。');
  }, 25000);

  it('3. renders long content, code blocks, relative images, math, and mermaid in Visual mode', async () => {
    const lines: string[] = [
      '# Rich Document',
      '',
      '![Local Image](./assets/sample.png)',
      '',
      '```ts',
      'function testCodeBlock() {',
      '  return 42;',
      '}',
      '```',
      '',
      '$$',
      '\\sum_{i=1}^n x_i = X',
      '$$',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      'And inline math $E = mc^2$ here.',
      ''
    ];
    // Add 100 extra lines for long content
    for (let i = 1; i <= 100; i++) {
      lines.push(`Paragraph line ${i} with some descriptive text.`);
    }

    activeApp = sharedApp;
    await activeApp.setSource(lines.join('\n'));

    // Switch to Visual mode
    await ensureSurface(activeApp, 'visual');

    // Verify visual widgets rendered
    await activeApp.waitForSelector('.cm-visual-code-block', 15000);
    await activeApp.waitForSelector('.cm-visual-block-math', 15000);
    await activeApp.waitForSelector('.cm-mermaid-preview', 15000);
    await activeApp.waitForSelector('.cm-visual-inline-math', 15000);

    // Switch back to Source mode
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);
    const sourceText = await activeApp.getText('.cm-content');
    expect(sourceText).toContain('\\sum_{i=1}^n x_i = X');
    expect(sourceText).toContain('```mermaid');
  }, 25000);

  it('4. performs Source and Visual edits on the same document and verifies canonical round-trip', async () => {
    activeApp = sharedApp;
    await activeApp.setSource('# Original Title\n\n```text\nBody paragraph.\n```\n');

    // Source edit: use the real active EditorView transaction, not a synthetic DOM event.
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('Active Source EditorView is unavailable');
      view.dispatch({ changes: { from: 0, to: 16, insert: '# Source Title' } });
    })()`);
    await activeApp.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('# Source Title')`,
      15000
    );

    // Visual edit: edit the code-block line in visual mode via native document line
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    await activeApp.waitForSelector('.cm-visual-code-content-line', 15000);
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('Active Visual EditorView is unavailable');
      const doc = view.state.doc.toString();
      const target = 'Body paragraph.';
      const idx = doc.indexOf(target);
      if (idx === -1) throw new Error('Could not find code body in doc');
      view.dispatch({ changes: { from: idx, to: idx + target.length, insert: 'Visual body edit.' } });
    })()`);
    await activeApp.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('Visual body edit.')`,
      15000
    );

    // Switch back to Source and verify both edits survive in canonical Markdown.
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);
    const sourceText = await activeApp.evaluate<string>(
      `window.nexusSession.getSnapshot().source`
    );
    expect(sourceText).toContain('# Source Title');
    expect(sourceText).toContain('Visual body edit.');

    await activeApp.waitForFunction(
      `() => document.querySelector('.status-text')?.textContent?.includes('Saved')`,
      10000
    );
    expect(fs.readFileSync(sharedDocPath, 'utf-8')).toContain('Visual body edit.');
  }, 25000);

  it('5. auto-saves with debounce and atomic write, preserving CRLF line endings', async () => {
    const crlfFile = path.join(tempDir, 'crlf-autosave.md');
    const originalCrlf = '# CRLF Header\r\n\r\nFirst line.\r\nSecond line.\r\n';
    fs.writeFileSync(crlfFile, originalCrlf, 'utf-8');

    activeApp = await launchElectronApp({ filePath: crlfFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Verify initial save state is saved
    //
    // 回归：保存状态的展示已收敛到状态栏一处。此前状态栏用 `saveState !== 'saved'`
    // 判断"是否已落盘"，把 `clean`（刚加载完的初始状态）也算成脏的，
    // 于是刚打开的文件会显示 Modified。
    const initialBadge = await activeApp.getText('.status-text');
    expect(initialBadge.toLowerCase()).toContain('saved');
    // 标题栏不再有状态徽标与脏标记
    expect(
      await activeApp.evaluate(
        `document.querySelectorAll('.nexus-save-badge, .nexus-dirty-indicator').length`
      )
    ).toBe(0);

    // Trigger edit in editor via session
    await activeApp.evaluate(`(() => {
      window.nexusSession.dispatch({
        changes: [{ from: 0, to: 0, insert: 'Updated ' }]
      });
    })()`);

    // Verify save state transitions and auto-save occurs
    await activeApp.waitForFunction(`() => {
      const badge = document.querySelector('.status-text');
      return badge && badge.textContent && badge.textContent.includes('Saved');
    }`, 15000);

    // Read file from disk and check CRLF preserved
    const diskContent = fs.readFileSync(crlfFile, 'utf-8');
    expect(diskContent).toContain('Updated');
    expect(diskContent).toContain('\r\n');
  }, 25000);

  it('6. detects external file changes and displays conflict resolution options when dirty', async () => {
    const conflictFile = path.join(tempDir, 'conflict-test.md');
    fs.writeFileSync(conflictFile, '# Conflict Test\n\nInitial local text.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: conflictFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Make local editor dirty via session
    await activeApp.evaluate(`(() => {
      window.nexusSession.dispatch({
        changes: [{ from: 0, to: 0, insert: 'Local modified ' }]
      });
    })()`);

    // External modification to file
    fs.writeFileSync(conflictFile, '# Conflict Test\n\nExternal modified text by another editor.', 'utf-8');

    // Wait for conflict banner / notification
    await activeApp.waitForSelector('.nexus-conflict-banner', 15000);

    // 横幅文案必须跟着 locale 走。
    // 原先这里写死断言中文，而 app 默认 en-US —— 那其实是在断言「文案是硬编码的」，
    // 只要 userData 里没存过 zh-CN 就会假失败，也会把 i18n 收口挡在门外。两个方向各验一次。
    const originalLocale = await activeApp.evaluate<string>('window.nexusLocale.locale');
    await activeApp.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); })()`);
    await activeApp.waitForFunction(`() => {
      const el = document.querySelector('.nexus-conflict-banner');
      return el && el.textContent && el.textContent.includes('outside Nexus');
    }`, 15000);

    await activeApp.evaluate(`(() => { window.nexusLocale.setLocale('zh-CN'); })()`);
    await activeApp.waitForFunction(`() => {
      const el = document.querySelector('.nexus-conflict-banner');
      return el && el.textContent && el.textContent.includes('外部');
    }`, 15000);

    // locale 会经 localStorage 持久化到 Electron userData，跨用例残留；用完还原。
    await activeApp.evaluate(
      `(() => { window.nexusLocale.setLocale(${JSON.stringify(originalLocale)}); })()`
    );
    await activeApp.waitForFunction(
      `() => window.nexusLocale.locale === ${JSON.stringify(originalLocale)}`,
      15000
    );

    // Click "Reload" / 重新加载
    await activeApp.click('.nexus-conflict-reload-btn');
    await activeApp.waitForFunction(`() => {
      const content = document.querySelector('.cm-content');
      return content && content.textContent && content.textContent.includes('External modified text');
    }`, 15000);
  }, 25000);

  it('7. displays error reason and recovery path when save fails (read-only target)', async () => {
    const readOnlyDir = path.join(tempDir, 'readonly-dir');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    const readOnlyFile = path.join(readOnlyDir, 'readonly-save-fail.md');
    fs.writeFileSync(readOnlyFile, '# Read Only Test\n\nOriginal text.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: readOnlyFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // locale 会经 localStorage 跨测试文件残留（`platform.ts` 在 setLocale 时写它）。
    // 下面断言的是中文文案，所以必须显式钉住，不能依赖前序文件留下的状态 ——
    // 否则前一个文件把它留成 en-US 时，这里会以「英文文案不匹配」的形式假失败。
    const originalLocale = await activeApp.evaluate<string>(`window.nexusLocale.locale`);
    await activeApp.evaluate(`(() => { window.nexusLocale.setLocale('zh-CN'); return true; })()`);

    const isWin = process.platform === 'win32';

    // 只读化必须放在 try 里面：它自己也会抛（见 runIcacls），放在 try 外面
    // 会让 finally 的还原整段跳过，把只读目录留在 tempDir 里。
    try {
      // Make directory read-only to prevent temporary file creation and atomic rename
      if (isWin) {
        await runIcacls([readOnlyDir, '/deny', '*S-1-1-0:(W)']);
      } else {
        fs.chmodSync(readOnlyDir, 0o555);
      }

      // Wait for fs.watch event from chmod/icacls to settle so it doesn't overwrite error with external-changed
      await new Promise(r => setTimeout(r, 1000));

      // Trigger save via session edit and Ctrl+S
      await activeApp.evaluate(`(() => {
        window.nexusSession.dispatch({
          changes: [{ from: 0, to: 0, insert: 'Attempt to save ' }]
        });
      })()`);

      await activeApp.pressKey('s', { ctrl: true });

      // Check if error state and recovery path are displayed
      await activeApp.waitForSelector('.status-dot.error, .nexus-save-error-banner', 15000);
      const errorText = await activeApp.getText('.nexus-save-error-banner, .status-text');
      expect(errorText.toLowerCase()).toMatch(/error|失败|eacces|eperm|denied/);

      // Verify recovery options (Save As / Retry)
      await activeApp.waitForSelector('.nexus-save-error-retry', 15000);
      await activeApp.waitForSelector('.nexus-save-error-saveas', 15000);

      // A failed save must keep the native close guard armed.
      await activeApp.pressKey('w', { ctrl: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(activeApp.proc.exitCode).toBeNull();
    } finally {
      // 还原 locale，别把中文留给后面的用例（它们可能断言英文文案）
      try {
        await activeApp.evaluate(
          `(() => { window.nexusLocale.setLocale(${JSON.stringify(originalLocale)}); return true; })()`
        );
      } catch {
        // 应用可能已经关掉了，还原失败不影响本用例结论
      }

      if (isWin) {
        try {
          await runIcacls([readOnlyDir, '/remove:d', '*S-1-1-0']);
        } catch {
          // ignore
        }
      } else {
        fs.chmodSync(readOnlyDir, 0o777);
      }
    }
  }, 30000);

  it('8. supports keyboard shortcuts: Mod-M toggle surface, Mod-F find', async () => {
    activeApp = sharedApp;
    await activeApp.setSource('# Keyboard Test\n\nParagraph text.');

    // Mod-M toggles to Visual
    await activeApp.pressKey('m', { ctrl: true });
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);

    // Mod-M toggles back to Source
    await activeApp.pressKey('m', { ctrl: true });
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);

    // Mod-F opens Search panel
    await activeApp.pressKey('f', { ctrl: true });
    await activeApp.waitForSelector('.cm-search', 15000);
  }, 25000);

  it('9. closes app and re-opens, verifying UTF-8 and CRLF preservation across restarts', async () => {
    const restartFile = path.join(tempDir, 'restart-test.md');
    const initialContent = '# Restart Test 🎉\r\n\r\nLine 1\r\nLine 2\r\n';
    fs.writeFileSync(restartFile, initialContent, 'utf-8');

    // First session
    activeApp = await launchElectronApp({ filePath: restartFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Edit and save
    await activeApp.evaluate(`(() => {
      window.nexusSession.dispatch({
        changes: [{ from: 0, to: 0, insert: 'Session 1: ' }]
      });
    })()`);
    await activeApp.pressKey('s', { ctrl: true });
    await activeApp.waitForFunction(`() => {
      const badge = document.querySelector('.status-text');
      return badge && badge.textContent && badge.textContent.includes('Saved');
    }`, 15000);

    // Close first session
    await activeApp.close();
    activeApp = null;

    // Second session: re-open same file
    activeApp = await launchElectronApp({ filePath: restartFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    const reloadedText = await activeApp.getText('.cm-content');
    expect(reloadedText).toContain('Session 1: # Restart Test 🎉');

    const diskBytes = fs.readFileSync(restartFile, 'utf-8');
    expect(diskBytes).toContain('\r\n');
    expect(diskBytes).toContain('Session 1: # Restart Test 🎉');
  }, 25000);

  it('10. prevents silent data loss when closing window with unsaved changes', async () => {
    const unsavedFile = path.join(tempDir, 'unsaved-close.md');
    fs.writeFileSync(unsavedFile, '# Unsaved Close Test\n\nBody content.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: unsavedFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Make local edit (dirty)
    await activeApp.evaluate(`(() => {
      window.nexusSession.dispatch({
        changes: [{ from: 0, to: 0, insert: 'Unsaved changes! ' }]
      });
    })()`);

    // Verify dirty indicator is shown
    await activeApp.waitForSelector('.status-dot.dirty', 15000);
    const isDirty = await activeApp.evaluate(`(() => {
      return document.querySelector('.status-text')?.textContent?.includes('Unsaved');
    })()`);
    expect(isDirty).toBe(true);

    // Attempt to close window with Mod-W
    await activeApp.pressKey('w', { ctrl: true });

    // Window must NOT close silently while dirty; process stays alive
    await new Promise((r) => setTimeout(r, 1000));
    expect(activeApp.proc.exitCode).toBeNull();
  }, 25000);

  it('11. allows ordinary Markdown editing in a document that contains math', async () => {
    const content = '# Math Degradation Test\n\nFormula: $E = mc^2$\n\nStandard paragraph here.';
    activeApp = sharedApp;
    await activeApp.setSource(content);

    // 状态栏不再有 Math 徽标：它的 "Ready" 只是"本文档含公式且检测器没抛异常"的
    // 只读回显，用户从公式渲染结果就能看出来；"Unavailable" 的判据其实是检测器
    // 抛异常，与渲染是否可用无关。渲染失败的降级路径由 extension-host 单测覆盖。
    expect(await activeApp.evaluate(`document.querySelectorAll('.status-extension-badge').length`)).toBe(0);

    // Edit standard paragraph text
    await activeApp.evaluate(`(() => {
      const src = window.nexusSession.getSnapshot().source;
      const targetPos = src.indexOf('Standard');
      window.nexusSession.dispatch({
        changes: [{ from: targetPos, to: targetPos, insert: 'Edited ' }]
      });
    })()`);

    // Switch to Visual mode
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);

    // Switch back to Source mode
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);

    const updatedSource = await activeApp.evaluate(`window.nexusSession.getSnapshot().source`);
    expect(updatedSource).toContain('$E = mc^2$');
    expect(updatedSource).toContain('Edited Standard paragraph here.');
  }, 25000);

  /**
   * katex 样式表的文件名带构建 hash，不能写死。按内容从构建产物里找出来：
   * `.katex{` 是 katex 自己的类名，minify 之后仍在。
   */
  function findKatexCssBasename(): string {
    const assetsDir = path.resolve(__dirname, '../out/renderer/assets');
    const hit = fs.readdirSync(assetsDir).find((name) => {
      if (!name.endsWith('.css')) return false;
      return fs.readFileSync(path.join(assetsDir, name), 'utf-8').includes('.katex{');
    });
    if (!hit) throw new Error(`katex stylesheet not found under ${assetsDir}`);
    return hit;
  }

  /**
   * P1-06 验收：「不含 Math/Mermaid 的文档不加载对应扩展；首次出现触发语法时才加载」。
   *
   * 主判据是 `window.nexusExtensions.requestedIds()`：动态 `import()` 只有
   * `LazyExtension.load()` 一条路径，所以这个列表为空 ⟺ 扩展包的 chunk 一个字节都没下载。
   *
   * 9b 再加一条**不依赖应用自己记账**的旁证：katex 的样式表是 Vite 在 chunk 加载时动态
   * 注入的 <link>，它在不在 document.head 里由打包器决定，应用写不出来。
   * （mermaid 没有独立样式表，拿不到同类旁证；9c 只能靠 requestedIds。）
   */
  const extensionState = (app: ElectronAppInstance) => {
    const katexCss = findKatexCssBasename();
    return app.evaluate<{ requested: string[]; loaded: string[]; katexStylesheet: boolean }>(
      `(() => ({
        requested: window.nexusExtensions.requestedIds(),
        loaded: window.nexusExtensions.loadedIds(),
        katexStylesheet: Array.from(document.querySelectorAll('link[rel=stylesheet]'))
          .some((l) => (l.getAttribute('href') || '').includes(${JSON.stringify(katexCss)}))
      }))()`
    );
  };

  it('9a. 不含公式与图表的文档不加载任何扩展包', async () => {
    const plainDoc = path.join(tempDir, 'ext-plain.md');
    fs.writeFileSync(plainDoc, '# 标题\n\n普通段落，没有公式也没有图表。\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: plainDoc });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Source surface 不挂 widget，此时不该有任何加载
    expect((await extensionState(activeApp)).requested).toEqual([]);

    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    // 等投影真的跑完再断言，否则「还没投影」会被误判成「没有触发语法」
    await activeApp.waitForFunction(
      `() => (document.querySelector('.cm-content')?.textContent || '').includes('普通段落')`,
      15000
    );

    const state = await extensionState(activeApp);
    expect(state.requested).toEqual([]);
    expect(state.loaded).toEqual([]);
    expect(state.katexStylesheet).toBe(false);
  }, 30000);

  it('9b. 只出现公式时只加载 math 扩展', async () => {
    const mathDoc = path.join(tempDir, 'ext-math.md');
    fs.writeFileSync(mathDoc, '# 公式\n\n行内 $E = mc^2$。\n\n$$ x^2 + y^2 = z^2 $$\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: mathDoc });
    await activeApp.waitForSelector('.cm-content', 15000);
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    // 真的渲染出公式（而不是退化成源码文本），才说明扩展加载成功
    await activeApp.waitForSelector('.cm-visual-block-math', 15000);
    await activeApp.waitForSelector('.katex', 15000);

    const state = await extensionState(activeApp);
    expect(state.requested).toEqual(['nexus-math']);
    expect(state.loaded).toEqual(['nexus-math']);
    // 打包器级旁证：katex 的样式表确实被拉下来了
    expect(state.katexStylesheet).toBe(true);
  }, 30000);

  it('9c. 只出现 mermaid 围栏时只加载 mermaid 扩展', async () => {
    const mermaidDoc = path.join(tempDir, 'ext-mermaid.md');
    fs.writeFileSync(mermaidDoc, '# 图\n\n```mermaid\ngraph TD\nA-->B\n```\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: mermaidDoc });
    await activeApp.waitForSelector('.cm-content', 15000);
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    await activeApp.waitForSelector('.cm-mermaid-preview svg', 15000);

    const state = await extensionState(activeApp);
    expect(state.requested).toEqual(['nexus-mermaid']);
    expect(state.loaded).toEqual(['nexus-mermaid']);
    expect(state.katexStylesheet).toBe(false);
  }, 30000);


  it('12. opens Command Palette and triggers toggle theme', async () => {
    activeApp = sharedApp;
    await activeApp.setSource('# Command Palette Test\n');

    // 主题信号读 <html data-theme>，值是主题 id（`ThemeManager.applyToDOM` 写入）。
    // 不要再用 body 的 `theme-*` class —— 全仓没有任何它的选择器，2026-09-28 已删。
    const themeBefore = await activeApp.evaluate('document.documentElement.dataset.theme');
    expect(themeBefore).not.toBe('nexus-dark');

    // Open Command Palette: Mod-K
    await activeApp.pressKey('k', { ctrl: true });
    await activeApp.waitForSelector('.nexus-command-palette', 15000);
    await new Promise(r => setTimeout(r, 200));

    await activeApp.typeText('theme');
    // 过滤是 React 异步渲染：原来只固定 sleep 200ms，负载高时列表还没更新，
    // Enter 会触发别的命令（主题没变 → 下面的 waitForFunction 超时，本会话复现过）。
    // 改成轮询第一项确实是 theme 命令。
    await activeApp.waitForFunction(
      `() => {
        const first = document.querySelector('.nexus-command-palette-item .nexus-command-title');
        return !!first && /theme/i.test(first.textContent || '');
      }`,
      15000
    );

    // Hit enter to trigger the first matching command
    await activeApp.pressKey('Enter');

    // Wait for theme to change
    await activeApp.waitForFunction(
      '() => document.documentElement.dataset.theme === "nexus-dark"',
      15000
    );
    
    // The palette should be closed
    const paletteExists = await activeApp.evaluate('!!document.querySelector(".nexus-command-palette")');
    expect(paletteExists).toBe(false);
  }, 25000);

  it('13. renders syntax highlighting for CPP code block in Visual mode', async () => {
    const content = [
      '# C++ Document',
      '',
      '```C++',
      'uint8_t a = 999;',
      'void aaa(uint8_t b){',
      '    a += b;',
      '}',
      '```',
      ''
    ].join('\n');
    activeApp = sharedApp;
    await activeApp.setSource(content);

    // Switch to Visual mode
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);

    // Wait for code block content lines and async syntax highlighting tokens
    await activeApp.waitForSelector('.cm-visual-code-content-line', 15000);
    await activeApp.waitForSelector('[class*="tok-"]', 15000);

    // Inspect tokens and controls via CDP evaluate
    const tokenInfo = await activeApp.evaluate(`(() => {
      const tokens = Array.from(document.querySelectorAll('[class*="tok-"]'));
      const headerLine = document.querySelector('.cm-visual-code-header-line');
      const langSelect = document.querySelector('.cm-code-language-select');
      const copyBtn = document.querySelector('.cm-code-copy-btn');

      return {
        count: tokens.length,
        hasHeaderLine: Boolean(headerLine),
        hasLangSelect: Boolean(langSelect),
        hasCopyBtn: Boolean(copyBtn)
      };
    })()`);

    expect(tokenInfo.count).toBeGreaterThan(0);
    expect(tokenInfo.hasHeaderLine).toBe(true);
    expect(tokenInfo.hasLangSelect).toBe(true);
    expect(tokenInfo.hasCopyBtn).toBe(true);
  }, 25000);

  it('14. clicks content line below table accurately without coordinate drift in Visual mode', async () => {
    const content = [
      '# Table Document',
      '',
      '| Col 1 | Col 2 |',
      '| :--- | :--- |',
      '| Val 1 | Val 2 |',
      '',
      'Target line directly below table.',
      'Second line below table.'
    ].join('\n');
    activeApp = sharedApp;
    await activeApp.setSource(content);

    // Switch to Visual mode
    await activeApp.click('[data-action="toggle-surface"]');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    await activeApp.waitForSelector('.cm-visual-table-container', 15000);

    // Locate the target line below the table in the DOM
    const targetLineInfo = await activeApp.evaluate(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const targetLine = lines.find((l) => l.textContent && l.textContent.includes('Target line directly below table.'));
      if (!targetLine) return null;
      const rect = targetLine.getBoundingClientRect();
      return {
        text: targetLine.textContent,
        x: Math.round(rect.left + 30),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`);

    expect(targetLineInfo).not.toBeNull();

    // Click at the exact physical center of the target line
    await activeApp.mouseClickCoords(targetLineInfo!.x, targetLineInfo!.y);

    // Verify where the cursor lands in the editor active line
    const cursorInfo = await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      const head = view ? view.state.selection.main.head : -1;
      const lineAtCursor = view && head >= 0 ? view.state.doc.lineAt(head).text : '';
      const posAtTarget = view ? view.posAtCoords({ x: ${targetLineInfo!.x}, y: ${targetLineInfo!.y} }) : null;
      const lineAtTarget = view && posAtTarget !== null ? view.state.doc.lineAt(posAtTarget).text : '';
      return {
        head,
        lineAtCursor,
        posAtTarget,
        lineAtTarget
      };
    })()`);

    expect(cursorInfo.lineAtTarget).toContain('Target line directly below table.');
    expect(cursorInfo.lineAtCursor).toContain('Target line directly below table.');
  }, 25000);
});

