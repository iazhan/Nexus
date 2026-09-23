import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * Visual surface 逐字符输入验收：
 * 在 Visual 模式下用真实按键（CDP）一个字符一个字符输入各种 Markdown 语法，
 * 校验 canonical source 保真，以及投影确实渲染出对应结构。
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-visual-typing-'));

interface TypingCase {
  id: string;
  name: string;
  /** \n 表示按下 Enter */
  typed: string;
  /** 必须出现在 canonical source 中的片段 */
  expected: string[];
  /** 需要精确等于的 canonical source（用于换行语义） */
  expectedExact?: string;
  /** Visual 投影中应出现的结构选择器 */
  dom?: string;
  /** 输入完成后等待补全面板出现并按 Enter 接受（slash 模板） */
  acceptCompletion?: boolean;
  /** 输入完成后按 Enter 提交（表格：移出表格后切换为 widget 预览） */
  commitWithEnter?: boolean;
}

const CASES: TypingCase[] = [
  { id: 'heading', name: 'ATX 标题', typed: '# Heading One', expected: ['# Heading One'] },
  { id: 'bold', name: '粗体', typed: '**bold text**', expected: ['**bold text**'] },
  { id: 'italic', name: '斜体', typed: '*italic text*', expected: ['*italic text*'] },
  {
    id: 'strike',
    name: '删除线',
    typed: '~~gone~~',
    expected: ['~~gone~~'],
    dom: '.cm-visual-strike'
  },
  {
    id: 'inline-code',
    name: '行内代码',
    typed: '`inline`',
    expected: ['`inline`'],
    dom: '.cm-visual-inline-code'
  },
  {
    id: 'link',
    name: '链接',
    typed: '[nexus](https://example.com)',
    expected: ['[nexus](https://example.com)'],
    dom: '.cm-visual-link'
  },
  { id: 'bullet-list', name: '无序列表', typed: '- item one', expected: ['- item one'] },
  { id: 'ordered-list', name: '有序列表', typed: '1. first item', expected: ['1. first item'] },
  {
    id: 'task-list',
    name: '任务列表',
    typed: '- [ ] task item',
    expected: ['- [ ] task item'],
    dom: '.cm-visual-task-checkbox'
  },
  { id: 'blockquote', name: '引用', typed: '> quoted line', expected: ['> quoted line'] },
  {
    id: 'horizontal-rule',
    name: '水平线',
    typed: '---',
    expected: ['---'],
    dom: '.cm-visual-horizontal-rule'
  },
  {
    id: 'code-block',
    name: '代码块（含围栏中间换行）',
    typed: '```js\nconst a = 1;\n```',
    expected: ['```js\nconst a = 1;\n```'],
    // 普通代码块在 ADR-0001 之后改为行级装饰流：围栏行由 CodeBlockHeaderWidget
    // 承载（.cm-code-header-widget），不再整体替换为 .cm-visual-code-block
    // ——后者现在只用于 mermaid 预览卡片。
    dom: '.cm-code-header-widget'
  },
  {
    id: 'math',
    name: '块级公式',
    typed: '$$x^2$$',
    expected: ['$$x^2$$'],
    dom: '.cm-visual-block-math'
  },
  {
    id: 'mermaid',
    name: 'Mermaid 图',
    typed: '```mermaid\ngraph TD\n```',
    expected: ['```mermaid\ngraph TD\n```'],
    dom: '.cm-mermaid-preview'
  },
  { id: 'cjk', name: '中文标题', typed: '# 中文标题', expected: ['# 中文标题'] },
  {
    // 段落回车只插入单换行（soft break），不额外制造空行
    id: 'paragraph-enter',
    name: '段落回车单换行',
    typed: 'line one\nline two',
    expected: ['line one', 'line two'],
    expectedExact: 'line one\nline two'
  },
  {
    // 逐行手输表格：依赖段落回车不插入空行（空行会打断 GFM 表格），
    // 写完按 Enter 提交后光标移出，表格切换为 widget 预览
    id: 'table',
    name: '表格逐行输入',
    typed: '| A | B |\n| --- | --- |',
    expected: ['| A | B |', '| --- | --- |'],
    expectedExact: '| A | B |\n| --- | --- |',
    dom: '.cm-visual-table',
    commitWithEnter: true
  },
  {
    // 表格后紧跟的段落不能再被吞进表格（否则该段落无法单独编辑）
    id: 'table-then-paragraph',
    name: '表格后紧跟段落',
    typed: '| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter paragraph',
    expected: ['| 1 | 2 |\nAfter paragraph'],
    expectedExact: '| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter paragraph',
    dom: '.cm-visual-table'
  },
  {
    // slash 模板补全：/table + Enter 插入表格模板
    id: 'table-snippet',
    name: 'slash 模板 /table',
    typed: '/table',
    acceptCompletion: true,
    expected: ['| Header 1 | Header 2 |', '| -------- | -------- |'],
    dom: '.cm-visual-table',
    commitWithEnter: true
  }
];

function isAsciiPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/**
 * 逐字符输入：ASCII 走真实按键；非 ASCII（中文/emoji）CDP 按键不携带文本，
 * 改用 Input.insertText 提交，同样经过编辑器输入处理链路。
 */
async function typeIntoVisual(app: ElectronAppInstance, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === '\n') {
      await app.pressKey('Enter');
    } else if (isAsciiPrintable(ch)) {
      await app.pressKey(ch);
    } else {
      await app.insertText(ch);
    }
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe('Visual surface per-character typing', () => {
  let app: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  for (const testCase of CASES) {
    it(`${testCase.name}：Visual 下逐字符输入后 source 保真`, async () => {
      const doc = path.join(tempDir, `${testCase.id}.md`);
      fs.writeFileSync(doc, '', 'utf8');

      app = await launchElectronApp({ filePath: doc });
      await app.waitForSelector('.cm-content', 15000);

      // 切到 Visual 并聚焦编辑器
      await app.click('.nexus-surface-toggle');
      await app.waitForSelector('[data-surface-kind="visual"]', 15000);
      await app.evaluate(`(() => {
        const view = window.nexusActiveView;
        if (!view) throw new Error('Active Visual EditorView unavailable');
        view.focus();
      })()`);

      await typeIntoVisual(app, testCase.typed);

      // 表格走补全模板：等待补全面板出现后按 Enter 接受
      if (testCase.acceptCompletion) {
        try {
          await app.waitForSelector('.cm-tooltip-autocomplete', 5000);
        } catch {
          console.log(
            '[COMPLETION-DEBUG]',
            await app.evaluate(`JSON.stringify({
              doc: window.nexusActiveView.state.doc.toString(),
              tooltips: Array.from(document.querySelectorAll('.cm-tooltip')).map(t => t.className),
              activeEl: document.activeElement?.className ?? null
            })`)
          );
          throw new Error('completion panel did not open');
        }
        await app.pressKey('Enter');
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // 表格提交：回车移出表格，随后应切换为 widget 预览
      if (testCase.commitWithEnter) {
        // 输入管道符不能弹出补全面板，否则下面的回车会被 acceptCompletion 抢走
        expect(
          await app.evaluate<number>(`document.querySelectorAll('.cm-tooltip').length`)
        ).toBe(0);
        await app.pressKey('Enter');
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // 投影结构（仍在 Visual 下校验）
      if (testCase.dom) {
        await app.waitForSelector(testCase.dom, 15000);
      }

      // canonical source 保真
      const sessionSource = await app.evaluate<string>(
        `window.nexusSession.getSnapshot().source`
      );
      for (const fragment of testCase.expected) {
        expect(sessionSource).toContain(fragment);
      }
      if (testCase.expectedExact !== undefined) {
        // 提交回车可能在末尾补一个换行，比较时忽略尾部换行
        expect(sessionSource.replace(/\n+$/, '')).toBe(testCase.expectedExact);
      }

      // 切回 Source，双 surface 与 session 必须一致
      await app.click('.nexus-surface-toggle');
      await app.waitForSelector('[data-surface-kind="source"]', 15000);
      const viewText = await app.evaluate<string>(`window.nexusActiveView.state.doc.toString()`);
      expect(viewText).toBe(sessionSource);
    }, 45000);
  }
});
