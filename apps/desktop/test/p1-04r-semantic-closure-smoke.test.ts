// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

// 32x32 实心 PNG。**不要换成 1x1**：点图那一步走 CDP 真实鼠标事件，坐标取元素中心后
// 按整数派发，而 1x1 的图渲染出来只有 1px 宽 —— 中心落到下一个像素就出界，点中的是行本身。
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANElEQVR4nO3OIQEAMAgAMDrRibRUIMsfAoGZmF9k9duYypUQEBAQEBAQEBAQEBAQEBC4DnyHeLKIDGjSfgAAAABJRU5ErkJggg==',
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
    fs.writeFileSync(imagePath, SAMPLE_PNG);

    // Write markdown document with relative image, bold, strikethrough, hr, and table
    const docPath = path.join(docDir, '测试文档.md');
    const initialContent = [
      '# 视觉模式语义收尾测试',
      '',
      '![测试图片](<./assets 资源/sample image.png>)',
      '',
      '![[assets 资源/sample image.png]]',
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
    // P3-07 起内嵌图片走 nexus-asset://（不再是 file://）—— http 页面（dev）加载不了
    // file:// 子资源，那会让 dev 下所有内嵌图片变空白。详见 @nexus/core 的 asset/url.ts
    expect(imageProps.src).toContain('nexus-asset://');

    // 4b. Obsidian 嵌入 `![[…]]` 走同一条资源通道。
    //     解析层把它拆成「`!` + wikilink」，识别发生在投影层 —— 这里守的是「真机上确实
    //     渲染成图片并真的加载出来了」，而不是只有投影层单测绿。
    await activeApp.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image-embed img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );

    const embedProps = await activeApp.evaluate(`(() => {
      const img = document.querySelector('.cm-visual-image-embed img');
      if (!img) return null;
      return { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth };
    })()`);

    expect(embedProps).not.toBeNull();
    expect(embedProps.complete).toBe(true);
    expect(embedProps.naturalWidth).toBeGreaterThan(0);
    expect(embedProps.src).toContain('nexus-asset://');
    // 嵌入不能退化成文字链接 —— 那正是「编辑时看不到图片」的症状。
    expect(await activeApp.evaluate(`document.querySelectorAll('.cm-visual-wikilink').length`)).toBe(0);

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

    // 10. Source 面同样渲染图片，且**只**渲染图片。
    //     上面 4 / 4b 守的是 Visual 面的加载，这里守的是 Source 面确实装了图片投影、
    //     并且宿主把文档目录喂了进去 —— 投影层单测绿不代表这条链路接上了。
    await activeApp.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image img');
        const embed = document.querySelector('.cm-visual-image-embed img');
        return Boolean(
          img && img.complete && img.naturalWidth > 0 &&
          embed && embed.complete && embed.naturalWidth > 0
        );
      }`,
      15000
    );

    const sourceImageProps = await activeApp.evaluate(`(() => {
      const img = document.querySelector('.cm-visual-image img');
      const embed = document.querySelector('.cm-visual-image-embed img');
      return { src: img.src, embedSrc: embed.src };
    })()`);

    expect(sourceImageProps.src).toContain('nexus-asset://');
    expect(sourceImageProps.embedSrc).toContain('nexus-asset://');

    // 其余语法在 Source 面一律保持源码原文。冒出一块表格控件 / 折叠的粗体标记，
    // 就等于在源码模式里偷偷开了一个半成品 Visual 模式。
    const sourceSurfaceText = await activeApp.evaluate(`document.querySelector('.cm-content').textContent`);
    expect(sourceSurfaceText).toContain('# 视觉模式语义收尾测试');
    expect(sourceSurfaceText).toContain('**粗体文字**');
    expect(sourceSurfaceText).toContain('| :--- | --- |');
    expect(await activeApp.evaluate(`document.querySelectorAll('.cm-visual-table').length`)).toBe(0);
    expect(await activeApp.evaluate(`document.querySelectorAll('.cm-visual-delimiter-revealed').length`)).toBe(0);

    // 10b. 点图 → 就地揭示为真实源文本（与行内公式同一套交互，不是弹浮层）。
    //      `workspaceRoot` 为 null 时没有图片列表，但揭示本身与宿主无关，照样成立。
    await activeApp.mouseClick('.cm-visual-image');
    await activeApp.waitForFunction(
      `() => Array.from(document.querySelectorAll('.cm-line'), (el) => el.textContent)
        .join('\\n')
        .includes('![测试图片](<./assets 资源/sample image.png>)')`,
      5000
    );
    // 揭示**不是**让图片消失：它另插一份留在原位，与源码同时在场。
    await activeApp.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image-alongside img'))`,
      5000
    );
  }, 60000);
});
