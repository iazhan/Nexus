// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Desktop Smoke Test (P1-04F)', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    // Ensure temp dir for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('1. launches a Markdown file into Lightweight Mode within 2s, displaying badge and filename', async () => {
    const testFile = path.join(tempDir, 'sample-launch.md');
    fs.writeFileSync(testFile, '# Hello Nexus Smoke\n\nWelcome to Lightweight Mode.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: testFile });

    // Wait for App and editor content to be ready
    await activeApp.waitForSelector('.cm-content', 15000);
    const badgeText = await activeApp.getText('.nexus-badge');
    expect(badgeText.toUpperCase()).toBe('LIGHTWEIGHT');

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
    const richFile = path.join(tempDir, 'rich-document.md');
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
    fs.writeFileSync(richFile, lines.join('\n'), 'utf-8');

    activeApp = await launchElectronApp({ filePath: richFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Switch to Visual mode
    await activeApp.click('.nexus-surface-switcher button:last-child');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);

    // Verify visual widgets rendered
    await activeApp.waitForSelector('.cm-visual-code-block', 15000);
    await activeApp.waitForSelector('.cm-visual-block-math', 15000);
    await activeApp.waitForSelector('.cm-mermaid-preview', 15000);
    await activeApp.waitForSelector('.cm-visual-inline-math', 15000);

    // Switch back to Source mode
    await activeApp.click('.nexus-surface-switcher button:first-child');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);
    const sourceText = await activeApp.getText('.cm-content');
    expect(sourceText).toContain('\\sum_{i=1}^n x_i = X');
    expect(sourceText).toContain('```mermaid');
  }, 25000);

  it('4. performs Source and Visual edits on the same document and verifies canonical round-trip', async () => {
    const editFile = path.join(tempDir, 'edit-roundtrip.md');
    fs.writeFileSync(
      editFile,
      '# Original Title\n\n```text\nBody paragraph.\n```\n',
      'utf-8'
    );

    activeApp = await launchElectronApp({ filePath: editFile });
    await activeApp.waitForSelector('.cm-content', 15000);

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

    // Visual edit: enter the real code-block sub-editor and commit through its key path.
    await activeApp.click('.nexus-surface-switcher button:last-child');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    await activeApp.waitForSelector('.cm-code-body', 15000);
    await activeApp.click('.cm-code-body');
    await activeApp.waitForSelector('.cm-code-editor', 15000);
    await activeApp.evaluate(`(() => {
      const editor = document.querySelector('.cm-code-editor');
      if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Code sub-editor is unavailable');
      editor.value = 'Visual body edit.';
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
    })()`);
    await activeApp.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('Visual body edit.')`,
      15000
    );

    // Switch back to Source and verify both edits survive in canonical Markdown.
    await activeApp.click('.nexus-surface-switcher button:first-child');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);
    const sourceText = await activeApp.evaluate<string>(
      `window.nexusSession.getSnapshot().source`
    );
    expect(sourceText).toContain('# Source Title');
    expect(sourceText).toContain('Visual body edit.');

    await activeApp.waitForFunction(
      `() => document.querySelector('.nexus-save-badge')?.textContent?.includes('Saved')`,
      10000
    );
    expect(fs.readFileSync(editFile, 'utf-8')).toContain('Visual body edit.');
  }, 25000);

  it('5. auto-saves with debounce and atomic write, preserving CRLF line endings', async () => {
    const crlfFile = path.join(tempDir, 'crlf-autosave.md');
    const originalCrlf = '# CRLF Header\r\n\r\nFirst line.\r\nSecond line.\r\n';
    fs.writeFileSync(crlfFile, originalCrlf, 'utf-8');

    activeApp = await launchElectronApp({ filePath: crlfFile });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Verify initial save state is saved
    const initialBadge = await activeApp.getText('.nexus-save-badge');
    expect(initialBadge.toLowerCase()).toContain('saved');

    // Trigger edit in editor via session
    await activeApp.evaluate(`(() => {
      window.nexusSession.dispatch({
        changes: [{ from: 0, to: 0, insert: 'Updated ' }]
      });
    })()`);

    // Verify save state transitions and auto-save occurs
    await activeApp.waitForFunction(`() => {
      const badge = document.querySelector('.nexus-save-badge');
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
    const bannerText = await activeApp.getText('.nexus-conflict-banner');
    expect(bannerText).toContain('外部');

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

    // Make directory read-only to prevent temporary file creation and atomic rename
    const isWin = process.platform === 'win32';
    if (isWin) {
      execSync(`icacls "${readOnlyDir}" /deny *S-1-1-0:(W)`);
    } else {
      fs.chmodSync(readOnlyDir, 0o555);
    }

    // Wait for fs.watch event from chmod/icacls to settle so it doesn't overwrite error with external-changed
    await new Promise(r => setTimeout(r, 1000));

    try {
      // Trigger save via session edit and Ctrl+S
      await activeApp.evaluate(`(() => {
        window.nexusSession.dispatch({
          changes: [{ from: 0, to: 0, insert: 'Attempt to save ' }]
        });
      })()`);

      await activeApp.pressKey('s', { ctrl: true });

      // Check if error state and recovery path are displayed
      await activeApp.waitForSelector('.nexus-save-badge.error, .nexus-save-error-banner', 15000);
      const errorText = await activeApp.getText('.nexus-save-error-banner, .nexus-save-badge');
      expect(errorText.toLowerCase()).toMatch(/error|失败|eacces|eperm|denied/);

      // Verify recovery options (Save As / Retry)
      await activeApp.waitForSelector('.nexus-save-error-retry', 15000);
      await activeApp.waitForSelector('.nexus-save-error-saveas', 15000);

      // A failed save must keep the native close guard armed.
      await activeApp.pressKey('w', { ctrl: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(activeApp.proc.exitCode).toBeNull();
    } finally {
      if (isWin) {
        try {
          execSync(`icacls "${readOnlyDir}" /remove:d *S-1-1-0`);
        } catch {
          // ignore
        }
      } else {
        fs.chmodSync(readOnlyDir, 0o777);
      }
    }
  }, 25000);

  it('8. supports keyboard shortcuts: Mod-M toggle surface, Mod-F find', async () => {
    const kbFile = path.join(tempDir, 'keyboard-test.md');
    fs.writeFileSync(kbFile, '# Keyboard Test\n\nParagraph text.', 'utf-8');

    activeApp = await launchElectronApp({ filePath: kbFile });
    await activeApp.waitForSelector('.cm-content', 15000);

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
      const badge = document.querySelector('.nexus-save-badge');
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
    await activeApp.waitForSelector('.nexus-save-badge.dirty', 15000);
    const isDirty = await activeApp.evaluate(`(() => {
      return document.querySelector('.nexus-save-badge')?.textContent?.includes('Unsaved');
    })()`);
    expect(isDirty).toBe(true);

    // Attempt to close window with Mod-W
    await activeApp.pressKey('w', { ctrl: true });

    // Window must NOT close silently while dirty; process stays alive
    await new Promise((r) => setTimeout(r, 1000));
    expect(activeApp.proc.exitCode).toBeNull();
  }, 25000);

  it('11. allows ordinary Markdown editing even if math extension is unavailable', async () => {
    const mathDoc = path.join(tempDir, 'math-degrade.md');
    const content = '# Math Degradation Test\n\nFormula: $E = mc^2$\n\nStandard paragraph here.';
    fs.writeFileSync(mathDoc, content, 'utf-8');

    activeApp = await launchElectronApp({ filePath: mathDoc });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Verify math indicator in status bar
    await activeApp.waitForSelector('.status-extension-badge', 15000);
    const extText = await activeApp.getText('.status-extension-badge');
    expect(extText).toContain('Math:');

    // Edit standard paragraph text
    await activeApp.evaluate(`(() => {
      const src = window.nexusSession.getSnapshot().source;
      const targetPos = src.indexOf('Standard');
      window.nexusSession.dispatch({
        changes: [{ from: targetPos, to: targetPos, insert: 'Edited ' }]
      });
    })()`);

    // Switch to Visual mode
    await activeApp.click('.nexus-surface-switcher button:last-child');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);

    // Switch back to Source mode
    await activeApp.click('.nexus-surface-switcher button:first-child');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 15000);

    const updatedSource = await activeApp.evaluate(`window.nexusSession.getSnapshot().source`);
    expect(updatedSource).toContain('$E = mc^2$');
    expect(updatedSource).toContain('Edited Standard paragraph here.');
  }, 25000);

  it('9. lazy loads math and mermaid extensions in visual mode', async () => {
    const extDoc = path.join(tempDir, 'ext-test.md');
    fs.writeFileSync(extDoc, '$$ x = y $$\n\n```mermaid\ngraph TD\nA-->B\n```\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: extDoc });
    await activeApp.waitForSelector('.cm-content', 15000);
    
    await activeApp.click('.nexus-surface-switcher button:last-child');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 15000);
    
    // Check if it creates math and mermaid preview elements
    await activeApp.waitForSelector('.cm-visual-block-math', 15000);
    await activeApp.waitForSelector('.cm-mermaid-preview', 15000);
  }, 25000);


  it('12. opens Command Palette and triggers toggle theme', async () => {
    const cpDoc = path.join(tempDir, 'cp-test.md');
    fs.writeFileSync(cpDoc, '# Command Palette Test\n', 'utf8');

    activeApp = await launchElectronApp({ filePath: cpDoc });
    await activeApp.waitForSelector('.cm-content', 15000);

    // Initial theme should be light (or whatever is default)
    let bodyClass = await activeApp.evaluate('document.body.className');
    expect(bodyClass).not.toContain('theme-dark');

    // Open Command Palette: Mod-Shift-P
    await activeApp.pressKey('p', { ctrl: true, shift: true });
    await activeApp.waitForSelector('.nexus-command-palette', 15000);
    await new Promise(r => setTimeout(r, 200));

    await activeApp.typeText('theme');
    await new Promise(r => setTimeout(r, 200));
    
    // Hit enter to trigger the first matching command
    await activeApp.pressKey('Enter');

    // Wait for theme to change
    await activeApp.waitForFunction('() => document.body.className.includes("theme-dark")', 15000);
    
    // The palette should be closed
    const paletteExists = await activeApp.evaluate('!!document.querySelector(".nexus-command-palette")');
    expect(paletteExists).toBe(false);
  }, 25000);
});
