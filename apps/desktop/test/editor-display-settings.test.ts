// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { countDocumentCharacters } from '@nexus/core';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 编辑器显示设置的**真行为**：行号槽、表格列宽、状态栏字数、外部修改处理。
 *
 * 这四项的共同点是「组件层断言不到」：
 *   - 行号槽走 CodeMirror 的 compartment，不是 CSS 变量 —— 只有真机能看到 gutter DOM 与它占的宽度；
 *   - 表格列宽由主题 CSS 的变量读，要 `getComputedStyle` 才看得见；
 *   - 状态栏字数要真的算出文档的字符数，不是「元素在不在」；
 *   - 外部修改要另一个进程真的写文件，才会触发 fs.watch。
 *
 * **一个文件只启动一次 Electron**（同文件多次启动会卡死），所以四条用例共用一次启动。
 */
describe('编辑器显示设置', () => {
  let tempDir: string;
  let docPath: string;
  let app: ElectronAppInstance;

  const SOURCE = [
    '# 标题',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '正文一行。'
  ].join('\n');

  /** 存档跨用例共享（Electron 的 user-data-dir 没按用例隔离），每个用例前显式归位。 */
  const RESET_SETTINGS = `
    window.nexusSettings.set('editor.lineNumbers', true);
    window.nexusSettings.set('editor.tableLayout', 'auto');
    window.nexusSettings.set('editor.wordCount', true);
    window.nexusSettings.set('general.externalChange', 'smart');
  `;

  beforeAll(async () => {
    tempDir = createTempDir('nexus-display-settings-');
    docPath = path.join(tempDir, 'doc.md');
    fs.writeFileSync(docPath, SOURCE, 'utf-8');
    app = await launchElectronApp({ filePath: docPath });
    await app.waitForSelector('.cm-content', 20000);
    await app.evaluate(RESET_SETTINGS);
  }, 120000);

  afterAll(async () => {
    if (app) {
      await app.evaluate(`
        localStorage.removeItem('nexus-editor-line-numbers');
        localStorage.removeItem('nexus-editor-table-layout');
        localStorage.removeItem('nexus-editor-word-count');
        localStorage.removeItem('nexus-external-change');
      `);
      await app.close();
    }
  });

  it('行号槽真的收掉（DOM 消失、正文左移），打开又回来', async () => {
    await app.evaluate(RESET_SETTINGS);
    const readGutter = `Boolean(document.querySelector('.cm-gutters .cm-lineNumbers'))`;
    const readContentLeft = `Math.round(document.querySelector('.cm-content').getBoundingClientRect().left)`;

    expect(await app.evaluate<boolean>(readGutter)).toBe(true);
    const withGutter = await app.evaluate<number>(readContentLeft);
    expect(withGutter).toBeGreaterThan(0);

    // 走**真实**路径：store 落盘 → 订阅 → compartment.reconfigure。
    await app.evaluate(`window.nexusSettings.set('editor.lineNumbers', false)`);
    await app.waitForFunction(
      `() => !document.querySelector('.cm-gutters .cm-lineNumbers')`,
      10000
    );
    // 只 `display: none` 藏起来的话宽度还在，正文不会左移 —— 这条就是那个判据。
    expect(await app.evaluate<number>(readContentLeft)).toBeLessThan(withGutter);

    await app.evaluate(`window.nexusSettings.set('editor.lineNumbers', true)`);
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-gutters .cm-lineNumbers'))`,
      10000
    );
    expect(await app.evaluate<number>(readContentLeft)).toBe(withGutter);
  }, 60000);

  it('表格列宽切到均分后 computed style 真的变', async () => {
    await app.evaluate(RESET_SETTINGS);

    // 表格只在可视化投影里有节点。
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
    await app.waitForSelector('.cm-visual-table', 20000);

    const readLayout = `getComputedStyle(document.querySelector('.cm-visual-table')).tableLayout`;
    expect(await app.evaluate<string>(readLayout)).toBe('auto');

    await app.evaluate(`window.nexusSettings.set('editor.tableLayout', 'fixed')`);
    await app.waitForFunction(
      `() => getComputedStyle(document.querySelector('.cm-visual-table')).tableLayout === 'fixed'`,
      10000
    );
    expect(await app.evaluate<string>(readLayout)).toBe('fixed');

    await app.evaluate(`window.nexusSettings.set('editor.tableLayout', 'auto')`);
    await app.waitForFunction(
      `() => getComputedStyle(document.querySelector('.cm-visual-table')).tableLayout === 'auto'`,
      10000
    );
  }, 60000);

  it('状态栏字数默认显示，数字与非空白字符数一致，关掉就消失', async () => {
    await app.evaluate(RESET_SETTINGS);

    const readCount = `(() => {
      const el = document.querySelector('[data-status-metric="character-count"]');
      if (!el) return null;
      const match = el.textContent.match(/[0-9]+/);
      return match ? Number(match[0]) : null;
    })()`;

    const expected = countDocumentCharacters(SOURCE);
    expect(await app.evaluate<number | null>(readCount)).toBe(expected);

    await app.evaluate(`window.nexusSettings.set('editor.wordCount', false)`);
    await app.waitForFunction(
      `() => !document.querySelector('[data-status-metric="character-count"]')`,
      10000
    );
    expect(await app.evaluate<number | null>(readCount)).toBeNull();

    await app.evaluate(`window.nexusSettings.set('editor.wordCount', true)`);
    await app.waitForFunction(
      `() => Boolean(document.querySelector('[data-status-metric="character-count"]'))`,
      10000
    );
  }, 60000);

  /**
   * 外部修改处理。`smart` 是改版前的行为（干净就自动重载），`prompt` 是新增的一档。
   *
   * 这条要真的从进程外写文件 —— `fs.watch` 是唯一入口，没有别的办法能构造出这个事件。
   */
  it('外部修改：smart 自动重载，prompt 一律弹冲突条', async () => {
    await app.evaluate(RESET_SETTINGS);
    const readDoc = `window.nexusActiveView.state.doc.toString()`;

    // smart：文档干净 → 自动重载。
    const SMART_MARKER = 'SMART-RELOAD-MARKER';
    fs.writeFileSync(docPath, `${SOURCE}\n\n${SMART_MARKER}`, 'utf-8');
    await app.waitForFunction(
      `() => window.nexusActiveView.state.doc.toString().includes(${JSON.stringify(SMART_MARKER)})`,
      15000
    );
    expect(await app.evaluate<string>(readDoc)).toContain(SMART_MARKER);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-conflict-banner').length`)
    ).toBe(0);

    // prompt：同样是干净文档，但**一律提示**。这正是这一档存在的意义 ——
    // 干净文档也走提示，否则它和 smart 完全同路，等于没生效。
    await app.evaluate(`window.nexusSettings.set('general.externalChange', 'prompt')`);
    const PROMPT_MARKER = 'PROMPT-MARKER';
    fs.writeFileSync(docPath, `${SOURCE}\n\n${SMART_MARKER}\n\n${PROMPT_MARKER}`, 'utf-8');
    await app.waitForSelector('.nexus-conflict-banner', 15000);
    // 没有自动重载：文档里不该出现第二次写进去的内容。
    expect(await app.evaluate<string>(readDoc)).not.toContain(PROMPT_MARKER);
  }, 90000);
});
