// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { markdownHighlightStyle, nexusBaseTheme } from '../src/theme.js';
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

describe('Editor Syntax Highlighting Theme', () => {
  it('defines highlight rules for core language constructs', () => {
    // markdownHighlightStyle is a HighlightStyle instance
    expect(markdownHighlightStyle).toBeInstanceOf(HighlightStyle);

    // Check that tags are matched by the style
    const tagsToCheck = [
      t.keyword,
      t.controlKeyword,
      t.string,
      t.comment,
      t.number,
      t.bool,
      t.variableName,
      t.function(t.variableName),
      t.propertyName,
      t.typeName,
      t.operator,
      t.punctuation
    ];

    for (const tag of tagsToCheck) {
      const match = markdownHighlightStyle.style([tag]);
      expect(match, `Tag ${tag} should have a highlight match in markdownHighlightStyle`).toBeTruthy();
    }

    // Control keyword should have distinct styling/class (tok-control)
    const controlMatch = markdownHighlightStyle.style([t.controlKeyword]);
    expect(controlMatch).toContain('tok-control');

    // Standard builtin variable (console, Math) should have tok-builtin
    const builtinMatch = markdownHighlightStyle.style([t.standard(t.variableName)]);
    expect(builtinMatch).toContain('tok-builtin');
  });

  it('does not contain hardcoded dark-theme pale fallback colors that wash out in light theme', () => {
    const rules = (markdownHighlightStyle as any).module?.rules;
    const rulesStr = Array.isArray(rules) ? rules.join('\n') : '';
    // Pale colors that washed out in light mode should NOT be present:
    expect(rulesStr).not.toContain('#dcdcaa'); // pale yellow function
    expect(rulesStr).not.toContain('#9cdcfe'); // pale cyan variable
    expect(rulesStr).not.toContain('#b5cea8'); // pale green number
    expect(rulesStr).not.toContain('#d4d4d4'); // pale gray operator/punctuation
  });

  it('guarantees theme rules reference tokens instead of carrying hex fallbacks', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ parent, extensions: [nexusBaseTheme] });
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');
    // 这四条断言以前写的是「CSS 里必须出现 #098658 / #795e26 / …」——那是把兜底色当成契约。
    // 兜底色等于第三套色板（token 注入失败时静默退回 Tailwind 色），2026-09-28 已全部剥掉，
    // 所以断言改成「引用 token」，并把那批旧兜底色列为禁止项。
    for (const token of ['syntax-number', 'syntax-function', 'syntax-variable', 'syntax-control']) {
      expect(styles).toContain(`var(--nexus-${token})`);
    }
    for (const gone of ['#098658', '#795e26', '#001080', '#af00db']) {
      expect(styles).not.toContain(gone);
    }
    view.destroy();
    parent.remove();
  });

  /**
   * 代码块行号的显示开关。
   *
   * 写死 `inline-block` 就等于「这个开关永远关不掉」，而设置页里它看起来仍然是个开关 ——
   * 静默失效，只有盯着看才发现。断言取生成的 CSS 文本，因为 `EditorView.theme()` 的值
   * 只在构造时求值，测试拿不到 spec 对象。
   */
  it('代码块行号的 display 走变量，而不是写死 inline-block', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ parent, extensions: [nexusBaseTheme] });
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');

    expect(styles).toContain('var(--nx-editor-code-line-numbers');
    view.destroy();
    parent.remove();
  });

  /**
   * 表格列宽的 `table-layout` 同样走变量。
   *
   * `table-layout` 只在构造时求值，写死 `auto` 会让「固定列宽」这个选项静默无效。
   */
  it('表格列宽走变量，而不是写死 auto', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ parent, extensions: [nexusBaseTheme] });
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');

    expect(styles).toContain('var(--nx-editor-table-layout');
    view.destroy();
    parent.remove();
  });

  /**
   * 内嵌图片必须被夹在内容宽度内。
   *
   * 图片尺寸来自文件本身，投影层拿不到，`max-width` 是唯一能兜住它的地方。缺了这条，
   * 一张 2001px 的图会把行宽推到 2009px（编辑区只有 655px），横向滚动条出现，
   * 而且 `.cm-scroller` 的居中会把行推到负坐标 —— 整篇内容看不见。
   */
  it('内嵌图片被夹在内容宽度内，不按原始像素撑开行宽', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ parent, extensions: [nexusBaseTheme] });
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');

    expect(styles).toContain('.cm-visual-image img');
    expect(styles).toMatch(/\.cm-visual-image img\s*\{[^}]*max-width:\s*100%/);
    view.destroy();
    parent.remove();
  });

  /**
   * 行盒必须有最小高度，否则 CRLF 文档的「行号重叠」会回来。
   *
   * CRLF 文档的行内容末尾带 `\r`（`Text.of(source.split('\n'))` 为了保住「doc 偏移 ==
   * source 偏移」而刻意保留它）。`\r` 零宽且不产生行盒，于是**只有 `\r` 的空行高度塌成 0**
   * —— 行号槽的高度由 CM 逐行测量得出，同样塌成 0，行号数字全被压在上一行的下边缘上。
   *
   * 2026-10-06 实测：120 行、纯 CRLF 的真实笔记里，19 个空行的行号元素 inline `height: 0px`，
   * 行号显示成 1、3、5、7、9、10、13、16… （跳号 + 错位）。加 `min-height` 后
   * `gutterH === contentH` 逐行相等（含 31/45/67/90 这些由标题与软换行撑出的非 22px 行）。
   *
   * 取值必须是 `calc(<行高变量> * 1em)`：写死像素会在用户改「行高」设置后失效，
   * 而 `min-height` 又恰好要比正常行高**不大** —— 大了整篇文档会被逐行拉长。
   */
  it('.cm-line 有跟随行高变量的 min-height，兜住 CRLF 空行高度塌成 0', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ parent, extensions: [nexusBaseTheme] });
    const styles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');

    expect(styles).toMatch(/\.cm-line\s*\{[^}]*min-height:\s*calc\(var\(--nx-editor-line-height[^)]*\)\s*\*\s*1em\)/);
    view.destroy();
    parent.remove();
  });
});
