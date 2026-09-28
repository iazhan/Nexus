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
});
