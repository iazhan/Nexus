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
 * 自动保存不得扰动编辑状态。
 *
 * 应用自己的 writeFile 会唤醒自己的 fs.watch，旧实现在“文档干净且已保存”时会把这次
 * 自发写入当成外部修改并整篇 replaceSource，导致光标被映射到文档末尾。这里用真实
 * Electron 运行时锁定该行为：输入一个字符、等自动保存落盘并往返一次后，光标必须仍
 * 停在输入后的位置。
 */
describe('Auto-save caret stability', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-autosave-caret-');
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('keeps the caret in place when the auto-save write round-trips through the watcher', async () => {
    const docPath = path.join(tempDir, 'caret.md');
    const initial = ['# 标题', '', '第一段文字。', '', '第二段文字。', '', '第三段文字。', ''].join('\n');
    fs.writeFileSync(docPath, initial, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 10000);

    // 把光标放在文档中段（"第二段文字。" 之后）
    const caretOffset = 22;
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      view.focus();
      view.dispatch({ selection: { anchor: ${caretOffset}, head: ${caretOffset} } });
      return view.state.selection.main.head;
    })()`);

    // 真实键盘输入，光标应前进 1
    await app.insertText('X');
    const afterTyping = await app.evaluate<number>('window.nexusActiveView.state.selection.main.head');
    expect(afterTyping).toBe(caretOffset + 1);

    // 等自动保存落盘（debounce 800ms）；并行跑整套时机器负载高，放宽到 20s
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((readFileTolerant(docPath) ?? '').includes('X')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readFileTolerant(docPath)).toContain('X');

    // 再等 fs.watch 事件与可能的整篇重载往返
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(
      await app.evaluate<boolean>(`Boolean(document.querySelector('.nexus-conflict-banner'))`)
    ).toBe(false);

    const settled = await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      return {
        head: view.state.selection.main.head,
        anchor: view.state.selection.main.anchor,
        source: window.nexusSession.getSnapshot().source
      };
    })()`);

    expect(settled.source).toBe(initial.replace('第三段文字。', 'X第三段文字。'));
    expect(settled.head).toBe(caretOffset + 1);
    expect(settled.anchor).toBe(caretOffset + 1);

    // 反向验证：上面的等待是盲等，若 watcher 根本没生效就会假绿。这里主动从外部改盘，
    // 确认 watcher 链路是活的，从而证明「光标没动」是真的没被重载，而不是没被观测到。
    fs.writeFileSync(docPath, initial.replace('第三段文字。', '外部修改。'), 'utf-8');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('外部修改')`,
      15000
    );
  }, 60000);
});
