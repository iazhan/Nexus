// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 视觉模式白屏守卫。
 *
 * 回归背景（2026-09-23）：`buildVisualProjection` 把装饰按 (from, to) 排序，
 * 漏掉了 RangeSetBuilder 真正要求的第二关键字 `startSide`。`[![alt](img)](url)`
 * 这种「链接文字本身就是一个 widget」的结构里，链接 mark 与图片 replace 的
 * from/to 完全相同，先推 mark 就会抛
 * "Ranges must be added sorted by `from` position and `startSide`"。
 * 该函数在 StateField.create 里被调用 → EditorState 构造失败 → React 无错误边界
 * 会卸载整棵树 → 打开文件直接白屏。
 *
 * 这里用真实 Electron 守住整条链路：投影层不许抛，渲染层不许把界面掀掉。
 */
describe('Visual mode white-screen guard', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-whitescreen-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  const trickyDocument = [
    '# 白屏回归样本',
    '',
    '## 链接文字是图片',
    '',
    '[![Nexus 图标](./assets/nexus-logo.png)](https://example.com)',
    '',
    '## 链接文字是其他行内节点',
    '',
    '[**粗体**](https://e.com)、[`行内代码`](https://e.com)、[~~删除线~~](https://e.com)、[$E=mc^2$](https://e.com)',
    '',
    '## 引用块嵌套',
    '',
    '> 段落',
    '>',
    '> - 引用里的列表',
    '> - 第二项',
    '>',
    '> ```text',
    '> 引用里的代码块',
    '> ```',
    '',
    '## 四反引号围栏包三反引号',
    '',
    '````text',
    '```',
    '````',
    '',
    '## 列表与任务',
    '',
    '- 无序项',
    '  - 嵌套项 [![n](./n.png)](https://e.com)',
    '',
    '- [ ] 待办',
    '- [x] 已完成',
    '',
    '## 表格',
    '',
    '| 列 | 说明 |',
    '| --- | --- |',
    '| `code` | [link](https://e.com) |',
    '',
    '## 块级公式',
    '',
    '$$',
    'E = mc^2',
    '$$'
  ].join('\n');

  async function assertNotWhiteScreened(app: ElectronAppInstance, expectedSource: string): Promise<void> {
    const state = await app.evaluate<{
      rootChildCount: number;
      hasErrorCard: boolean;
      errorText: string;
      hasCmContent: boolean;
      surfacePressed: string | null;
      source: string;
    }>(`(() => {
      const root = document.getElementById('root');
      return {
        rootChildCount: root ? root.children.length : -1,
        hasErrorCard: Boolean(document.querySelector('.nexus-error-card')),
        errorText: document.querySelector('.nexus-error-card')?.textContent ?? '',
        hasCmContent: Boolean(document.querySelector('.cm-content')),
        surfacePressed: document.querySelector('.nexus-surface-toggle')?.getAttribute('aria-pressed') ?? null,
        source: window.nexusSession ? window.nexusSession.getSnapshot().source : ''
      };
    })()`);

    // 白屏的判定：React 根被卸载干净，界面上什么都没有。
    expect(state.rootChildCount).toBeGreaterThan(0);
    expect(state.hasCmContent).toBe(true);
    // 兜底错误卡片不该出现——投影层自己就必须不抛。
    expect(state.errorText).toBe('');
    expect(state.hasErrorCard).toBe(false);
    expect(state.surfacePressed).toBe('true');
    // 渲染失败绝不能改动 canonical source。
    expect(state.source).toBe(expectedSource);
  }

  it('opens a document full of tricky nesting in Visual mode without white-screening', async () => {
    const docPath = path.join(tempDir, 'tricky.md');
    fs.writeFileSync(docPath, trickyDocument, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;

    await app.waitForSelector('.cm-content', 20000);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);

    await assertNotWhiteScreened(app, trickyDocument);

    // 被链接包裹的图片必须真的渲染成图片 widget，且两个链接分隔符都藏起来。
    const linkedImage = await app.evaluate<{ images: number; delimiters: string[] }>(`(() => ({
      images: document.querySelectorAll('.cm-visual-image').length,
      delimiters: Array.from(document.querySelectorAll('.cm-visual-hidden-delimiter'))
        .map((el) => el.dataset.delimiter)
        .filter((value) => typeof value === 'string' && value.includes('example.com'))
    }))()`);
    expect(linkedImage.images).toBeGreaterThan(0);
    expect(linkedImage.delimiters).toEqual(['](https://example.com)']);

    // 滚到文末，确认长文档后段同样不会崩。
    await app.evaluate(`(() => {
      const scroller = document.querySelector('.cm-scroller');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await assertNotWhiteScreened(app, trickyDocument);
  }, 90000);
});
