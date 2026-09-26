// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

// 1x1 transparent PNG binary
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

describe('P1-04R Semantic Closure Electron Smoke Test', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-smoke-p1-04r-');
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('verifies relative image loading, delimiter reveal, table controls, and edit/undo roundtrip in Visual mode', async () => {
    // 1. Create document directory with Chinese and spaces
    const docDir = path.join(tempDir, '项目 测试 with spaces');
    const assetsDir = path.join(docDir, 'assets 资源');
    fs.mkdirSync(assetsDir, { recursive: true });

    // Write real 1x1 PNG image
    const imagePath = path.join(assetsDir, 'sample image.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);

    // Write markdown document with relative image, bold, strikethrough, hr, and table
    const docPath = path.join(docDir, '测试文档.md');
    const initialContent = [
      '# 视觉模式语义收尾测试',
      '',
      '![测试图片](<./assets 资源/sample image.png>)',
      '',
      '段落文本 **粗体文字** 和 ~~删除线文字~~ 以及 普通文字。',
      '',
      '---',
      '',
      '| 标题一 | 标题二 |',
      '| :--- | --- |',
      '| 单元格1 | 单元格2 |',
      '| 单元格3 | 单元格4 |',
      ''
    ].join('\n');

    fs.writeFileSync(docPath, initialContent, 'utf-8');

    // 2. Launch real Electron app with the test file
    activeApp = await launchElectronApp({ filePath: docPath });
    /** 每一步等待完整正文，防止表格分隔行等无关文本提前满足条件。 */
    const app = activeApp;
    async function expectSource(expected: string): Promise<void> {
      await app.waitForFunction(`() => window.nexusSession.getSnapshot().source === ${JSON.stringify(expected)}`, 5000);
      expect(await app.evaluate<string>('window.nexusSession.getSnapshot().source')).toBe(expected);
    }
    await activeApp.waitForSelector('.cm-content', 10000);

    // Verify title bar displays Chinese filename
    const filename = await activeApp.getText('.nexus-filename');
    expect(filename).toContain('测试文档.md');

    // 3. Switch to Visual mode
    await activeApp.click('.nexus-surface-toggle');
    await activeApp.waitForSelector('[data-surface-kind="visual"]', 10000);

    // 4. Verify relative image successfully loads with naturalWidth > 0
    await activeApp.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );

    const imageProps = await activeApp.evaluate(`(() => {
      const img = document.querySelector('.cm-visual-image img');
      if (!img) return null;
      return {
        src: img.src,
        alt: img.alt,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight
      };
    })()`);

    expect(imageProps).not.toBeNull();
    expect(imageProps.alt).toBe('测试图片');
    expect(imageProps.complete).toBe(true);
    expect(imageProps.naturalWidth).toBeGreaterThan(0);
    expect(imageProps.naturalHeight).toBeGreaterThan(0);
    expect(imageProps.src).toContain('file:///');

    // 5. Verify delimiter reveal on caret entry/exit and real blur/focus
    // 5a. Initial: caret at 0, no revealed delimiters
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('Active view unavailable');
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 0 } });
    })()`);

    const revealedCount = await activeApp.evaluate(`document.querySelectorAll('.cm-visual-delimiter-revealed').length`);
    expect(revealedCount).toBe(0);

    // 5b. Move caret inside **粗体文字**
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      const source = view.state.doc.toString();
      const boldPos = source.indexOf('粗体文字') + 1;
      view.focus();
      view.dispatch({ selection: { anchor: boldPos, head: boldPos } });
    })()`);

    await activeApp.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-delimiter-revealed').length === 2`,
      5000
    );
    const revealedBoldText = await activeApp.evaluate(
      `Array.from(document.querySelectorAll('.cm-visual-delimiter-revealed'), (el) => el.textContent).join('')`
    );
    expect(revealedBoldText).toBe('****');

    // 5c. Blur editor to outside element (title) -> delimiters hidden
    await activeApp.mouseClick('.nexus-app-title');
    await activeApp.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-delimiter-revealed').length === 0`,
      5000
    );

    // 5d. Refocus editor -> delimiters revealed again
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      view.focus();
    })()`);
    await activeApp.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-delimiter-revealed').length === 2`,
      5000
    );

    // 5e. Move caret inside ~~删除线文字~~
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      const source = view.state.doc.toString();
      const strikePos = source.indexOf('删除线文字') + 1;
      view.focus();
      view.dispatch({ selection: { anchor: strikePos, head: strikePos } });
    })()`);

    await activeApp.waitForFunction(
      `() => {
        const els = document.querySelectorAll('.cm-visual-delimiter-revealed');
        return els.length === 2 && Array.from(els, (e) => e.textContent).join('') === '~~~~';
      }`,
      5000
    );

    // 6. Verify strikethrough shortcut Mod-Shift-x with real keydown
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      const source = view.state.doc.toString();
      const pos = source.indexOf('普通文字');
      view.focus();
      view.dispatch({ selection: { anchor: pos, head: pos + 4 } });
    })()`);

    await activeApp.pressKey('x', { ctrl: true, shift: true });
    await activeApp.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('~~普通文字~~')`,
      5000
    );
    expect(await activeApp.evaluate(`window.nexusSession.getSnapshot().source`)).toContain('~~普通文字~~');

    // Undo strikethrough
    await activeApp.evaluate(`window.nexusSession.undo()`);
    await activeApp.waitForFunction(
      `() => !window.nexusSession.getSnapshot().source.includes('~~普通文字~~')`,
      5000
    );

    // 7. Verify table controls: consecutive ops (select col 1 -> align center -> delete col 1 without re-clicking)
    await activeApp.waitForSelector('[data-table-action="delete-column"]', 5000);

    const revBeforeAlign = await activeApp.evaluate<number>(`window.nexusSession.getSnapshot().revision`);
    const alignedSource = initialContent.replace('| :--- | --- |', '| :--- | :---: |');
    const deletedSource = initialContent.replace(
      '| 标题一 | 标题二 |\n| :--- | --- |\n| 单元格1 | 单元格2 |\n| 单元格3 | 单元格4 |',
      '| 标题一 |\n| :--- |\n| 单元格1 |\n| 单元格3 |'
    );

    // Click on cell '单元格2' (row 0, col 1) using real mouseClick
    await activeApp.mouseClick('.cm-visual-table td[data-row="0"][data-col="1"]');

    // Click align-center button
    await activeApp.mouseClick('[data-table-action="align-center"]');
    await expectSource(alignedSource);

    const revAfterAlign = await activeApp.evaluate<number>(`window.nexusSession.getSnapshot().revision`);
    expect(revAfterAlign).toBe(revBeforeAlign + 1);

    // Directly click delete-column button WITHOUT re-clicking any cell
    await activeApp.mouseClick('[data-table-action="delete-column"]');
    await expectSource(deletedSource);

    // Undo delete-column -> intermediate text has ':---:' and '标题二'
    await activeApp.evaluate(`window.nexusSession.undo()`);
    await expectSource(alignedSource);

    // Undo align-center -> restored back to initial '---'
    await activeApp.evaluate(`window.nexusSession.undo()`);
    await expectSource(initialContent);
    await activeApp.evaluate('window.nexusSession.redo()');
    await expectSource(alignedSource);
    await activeApp.evaluate('window.nexusSession.redo()');
    await expectSource(deletedSource);
    await activeApp.evaluate('window.nexusSession.undo()');
    await expectSource(alignedSource);
    await activeApp.evaluate('window.nexusSession.undo()');
    await expectSource(initialContent);

    // 7b. Verify cell edit blur/commit via CDP toolbar click
    // Click on cell (row 1, col 1 -> '单元格4')
    await activeApp.mouseClick('.cm-visual-table td[data-row="1"][data-col="1"]');
    await activeApp.waitForSelector('.cm-visual-table td[data-row="1"][data-col="1"] .cm-table-cell-editor', 5000);
    // 单元格编辑器已由 <input> 换为 contenteditable 原位编辑，光标落在点击处，
    // 直接 insertText 只会插在光标位置。先选中整格内容再输入，等价于用户在
    // 单元格内按 Ctrl/Cmd+A 后替换。
    await activeApp.evaluate(`(() => {
      const editor = document.querySelector('.cm-visual-table td[data-row="1"][data-col="1"] .cm-table-cell-editor');
      editor.select();
      return true;
    })()`);
    await activeApp.insertText('已修改4');
    const editedCellSource = initialContent.replace('单元格4', '已修改4');
    const editedAlignedSource = editedCellSource.replace('| :--- | --- |', '| :--- | ---: |');

    // Click toolbar align-right button via CDP mouseClick (triggers blur, commits cell edit, and applies align-right)
    await activeApp.mouseClick('[data-table-action="align-right"]');
    await expectSource(editedAlignedSource);

    // Undo align-right (API undo)
    await activeApp.evaluate(`window.nexusSession.undo()`);
    await expectSource(editedCellSource);
    // Undo cell edit (API undo)
    await activeApp.evaluate(`window.nexusSession.undo()`);
    await expectSource(initialContent);
    await activeApp.evaluate('window.nexusSession.redo()');
    await expectSource(editedCellSource);
    await activeApp.evaluate('window.nexusSession.redo()');
    await expectSource(editedAlignedSource);
    await activeApp.evaluate('window.nexusSession.undo()');
    await expectSource(editedCellSource);
    await activeApp.evaluate('window.nexusSession.undo()');
    await expectSource(initialContent);

    // 8. Verify horizontal rule interactive editing via CDP keyboard input with spaces
    await activeApp.waitForSelector('.cm-visual-hr-container', 5000);
    await activeApp.evaluate(`document.querySelector('.cm-visual-hr-container').focus()`);
    await activeApp.pressKey('Enter');
    await activeApp.waitForSelector('.cm-hr-editor', 5000);

    // 逐键输入包含两个 Space 的水平线，覆盖真实 keydown/default 行为。
    await activeApp.typeText('* * *');
    await activeApp.pressKey('Enter');
    const editedHrSource = initialContent.replace('\n---\n', '\n* * *\n');
    await expectSource(editedHrSource);

    // Undo via real keyboard Mod-z
    await activeApp.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (view) view.focus();
    })()`);
    await activeApp.pressKey('z', { ctrl: true });
    await expectSource(initialContent);

    // Redo via real keyboard Mod-Shift-z
    await activeApp.pressKey('z', { ctrl: true, shift: true });
    await expectSource(editedHrSource);

    // Undo back to initial '---' via real Mod-z
    await activeApp.pressKey('z', { ctrl: true });
    await expectSource(initialContent);

    // 9. Switch back to Source surface and verify byte-for-byte consistency
    await activeApp.mouseClick('.nexus-surface-toggle');
    await activeApp.waitForSelector('[data-surface-kind="source"]', 5000);

    const sourceViewText = await activeApp.evaluate(`window.nexusActiveView.state.doc.toString()`);
    const sessionText = await activeApp.evaluate(`window.nexusSession.getSnapshot().source`);

    expect(sourceViewText).toBe(initialContent);
    expect(sessionText).toBe(initialContent);
  }, 45000);
});
