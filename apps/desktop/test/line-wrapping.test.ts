// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/** 足够长，在任何窗口宽度下都必须软换行。 */
const LONG_LINE = '这是一行很长的文字，用来验证软换行。'.repeat(40);

const DOC = [
  '# 标题',
  '',
  LONG_LINE,
  '',
  '短行一。',
  '短行二。',
  ''
].join('\n');

/**
 * 长行软换行。
 *
 * 三个断言缺一不可：
 *   1. 没有横向滚动 —— 这是用户看到的现象；
 *   2. 行号只给逻辑行 —— 超长行只占一个号，续行不带号；
 *   3. 超长行确实占了多个视觉行 —— 否则第 2 条可能是「压根没换行」蒙对的。
 */
describe('长行软换行', () => {
  let tempDir: string;
  let docPath: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wrap-'));
    docPath = path.join(tempDir, 'long.md');
    fs.writeFileSync(docPath, DOC, 'utf-8');
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

  it('超长行自动换行，无横向滚动，且续行不占行号', async () => {
    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    // 1. 没有横向滚动条
    const scroller = await app.evaluate<{ scrollWidth: number; clientWidth: number }>(
      `(() => {
        const el = document.querySelector('.cm-scroller');
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      })()`
    );
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);

    // 2. 行号只给逻辑行：文档 7 行（含末尾空行）就该只有 7 个号，
    //    超长行虽然占了很多视觉行，但只算一个逻辑行。
    //
    //    必须按 visibility 过滤：gutter 里还有一个 `visibility: hidden` 的
    //    宽度测量元素（内容是 '9'，用最大位数测宽），它不是行号。
    const numbers = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
        .filter((el) => getComputedStyle(el).visibility !== 'hidden')
        .map((el) => el.textContent ?? '')
        .filter((text) => text.trim().length > 0)`
    );
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6', '7']);

    // 3. 超长行确实换行了：它那一行的高度明显大于单行高度。
    //
    //    注意**不能**用 `.cm-line` 的数量来判断 —— 软换行不会增加 `.cm-line`，
    //    一个逻辑行仍然是一个 `.cm-line`，只是它内部折行了（我第一版就写错过）。
    const heights = await app.evaluate<number[]>(
      `Array.from(document.querySelectorAll('.cm-line')).map((el) =>
         Math.round(el.getBoundingClientRect().height))`
    );
    const titleHeight = heights[0]!; // '# 标题'
    const longLineHeight = heights[2]!; // 超长行
    expect(longLineHeight).toBeGreaterThan(titleHeight * 2);
  }, 45000);
});
