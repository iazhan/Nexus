// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 代码块行号开关。
 *
 * 行号是 `::before` 的生成内容（`content: attr(data-code-line-number)`），DOM 里没有对应节点，
 * 所以判据不能是「那个元素在不在」。两条一起看：
 *   1. `--nx-editor-code-line-numbers` 的取值 —— 证明设置 → store → 变量这条链通了；
 *   2. 代码正文的**左边界** —— 证明这个变量真的落到了样式上。
 * 缺第 2 条时，「变量写对了但 `display` 被写死」也会绿。
 */
describe('代码块行号开关', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-code-line-numbers-');
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  const SOURCE = [
    '# 代码',
    '',
    '```ts',
    'const a = 1;',
    'const b = 2;',
    '```',
    '',
    '后段正文。'
  ].join('\n');

  it('关掉之后行号槽消失、正文贴回左边框，打开又回来', async () => {
    const docPath = path.join(tempDir, 'code.md');
    fs.writeFileSync(docPath, SOURCE, 'utf-8');
    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
    await app.waitForSelector('.cm-visual-code-content-line[data-code-line-number]', 20000);

    // 存档跨用例共享（Electron 的 user-data-dir 没按用例隔离），先显式归位再断言。
    await app.evaluate(`window.nexusSettings.set('editor.codeBlockLineNumbers', true)`);

    const readVar = `document.documentElement.style.getPropertyValue('--nx-editor-code-line-numbers')`;
    /** 代码正文的左边界。行号槽排在正文之前，所以开关前后必须不同。 */
    const readTextLeft = `(() => {
      const line = document.querySelector('.cm-visual-code-content-line[data-code-line-number]');
      const range = document.createRange();
      range.selectNodeContents(line);
      return Math.round(range.getBoundingClientRect().left);
    })()`;

    expect(await app.evaluate<string>(readVar)).toBe('inline-block');
    const withGutter = await app.evaluate<number>(readTextLeft);
    expect(withGutter).toBeGreaterThan(0);

    // 走**真实**路径：store 落盘 → 订阅 → 写 documentElement 变量。绕过去直接改变量
    // 就测不出订阅链断没断。
    await app.evaluate(`window.nexusSettings.set('editor.codeBlockLineNumbers', false)`);
    expect(await app.evaluate<string>(readVar)).toBe('none');
    const withoutGutter = await app.evaluate<number>(readTextLeft);
    // 行号槽是 2.5ch + 12px margin + 8px padding（约 40px），这里只要求「确实左移了」——
    // 具体像素数随字号变，把它写进断言等于把字体设置也钉死。
    expect(withoutGutter).toBeLessThan(withGutter - 20);

    await app.evaluate(`window.nexusSettings.set('editor.codeBlockLineNumbers', true)`);
    expect(await app.evaluate<number>(readTextLeft)).toBe(withGutter);

    // 还原：别把 `false` 留给后面的用例。
    await app.evaluate(`localStorage.removeItem('nexus-editor-code-block-line-numbers')`);
  }, 120000);
});
