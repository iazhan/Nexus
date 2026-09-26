// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  readFileTolerant,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 行内代码必须可以就地编辑。
 *
 * 旧实现把整个 `` `code` `` 区间替换成 InlineCodeWidget，正文不是文档文本，
 * 因此点击只能打开 popover 再靠 Save 按钮回写。改成与 bold 同构的
 * 「只替换反引号围栏 + 正文保留为真实文本」之后，真实鼠标点击必须把光标
 * 放进正文内部，并且直接敲键就能改写 source —— 不需要任何按钮。
 *
 * 这里用真实 Electron + CDP 鼠标与键盘验证，happy-dom 无法证明光标真的落得进去。
 */
describe('Inline code in-place editing', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-inline-code-');
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('places the caret inside the code text and writes a keystroke straight back to source', async () => {
    const docPath = path.join(tempDir, 'inline-code.md');
    const initial = ['# 标题', '', 'Run `npm test` here.', ''].join('\n');
    fs.writeFileSync(docPath, initial, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 15000);

    // 应用默认挂在 Source surface，先切到 Visual
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 15000);
    await app.waitForSelector('.cm-visual-inline-code', 15000);

    // 反引号围栏 [10, 11) 与 [19, 20) 之外才是正文，光标必须落在正文里。
    const openFence = initial.indexOf('`');
    const closeFence = initial.indexOf('`', openFence + 1);
    expect(openFence).toBe(10);
    expect(closeFence).toBe(19);

    // 不再是 widget：正文是真实文档文本。
    const shape = await app.evaluate(`(() => ({
      widgets: document.querySelectorAll('.cm-visual-inline-code-widget').length,
      hiddenFences: Array.from(document.querySelectorAll('.cm-visual-hidden-delimiter'))
        .filter((el) => el.dataset.delimiter === String.fromCharCode(96)).length
    }))()`);
    expect(shape.widgets).toBe(0);
    expect(shape.hiddenFences).toBe(2);

    // 真实鼠标点击正文
    await app.mouseClick('.cm-visual-inline-code');

    const afterClick = await app.evaluate<{ head: number; inCodeText: boolean; popover: boolean }>(
      `(() => {
        const view = window.nexusActiveView;
        const head = view.state.selection.main.head;
        const selection = document.getSelection();
        const node = selection && selection.anchorNode;
        const element = node && (node.nodeType === 1 ? node : node.parentElement);
        return {
          head,
          inCodeText: Boolean(element && element.closest('.cm-visual-inline-code')),
          popover: document.querySelector('.cm-inline-edit-popover') !== null
        };
      })()`
    );

    // 光标落在正文区间内 —— widget 方案下正文不可编辑，这里必然失败。
    expect(afterClick.head).toBeGreaterThan(openFence);
    expect(afterClick.head).toBeLessThan(closeFence + 1);
    expect(afterClick.inCodeText).toBe(true);
    // 不再弹出带 Save / Cancel 按钮的 popover。
    expect(afterClick.popover).toBe(false);

    // 进入编辑态时围栏应当显示出来
    const revealed = await app.evaluate<number>(
      `document.querySelectorAll('.cm-visual-delimiter-revealed').length`
    );
    expect(revealed).toBe(2);

    // 直接敲键即可改写，不需要任何提交动作
    await app.insertText('X');
    const expected = initial.slice(0, afterClick.head) + 'X' + initial.slice(afterClick.head);

    expect(
      await app.evaluate<string>('window.nexusSession.getSnapshot().source')
    ).toBe(expected);

    // 等自动保存落盘（debounce 800ms）；并行跑整套时机器负载高，放宽到 20s
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (readFileTolerant(docPath) === expected) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readFileTolerant(docPath)).toBe(expected);
  }, 60000);
});
