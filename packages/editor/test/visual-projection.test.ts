import { describe, expect, it } from 'vitest';
import { MarkdownDocumentSession, createSessionEditorState, visualProjectionField } from '../src/index.js';

describe('Visual surface projection', () => {
  it('keeps Markdown source as the EditorState document', () => {
    const source = '# Title\n\nThis is **important**.';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    expect(state.doc.toString()).toBe(source);
  });

  it('uses a decoration/widget projection instead of an HTML document', () => {
    const source = '# Title\n\nThis is **important**.';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });
    const ranges: Array<{ from: number; to: number; hasWidget: boolean }> = [];

    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      ranges.push({
        from,
        to,
        hasWidget: Boolean(value.spec.widget)
      });
    });

    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.some((range) => range.hasWidget)).toBe(true);
    expect(state.doc.toString()).toBe(source);
  });

  it('does not install visual projection decorations on the Source surface', () => {
    const session = new MarkdownDocumentSession('# Title');
    const state = createSessionEditorState({
      session,
      surfaceId: 'source-test',
      surfaceKind: 'source'
    });

    expect(state.field(visualProjectionField, false)).toBeUndefined();
  });

  it('does not generate TaskCheckboxWidget for - [ ] inside fenced code blocks or raw blocks', () => {
    const source = '```ts\n- [ ] code, not task\n```\n\n<div class="test">\n- [ ] html, not task\n</div>\n\n- [ ] Real task';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const checkboxWidgets: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget;
      if (widget && 'checked' in widget) {
        checkboxWidgets.push({ from, to });
      }
    });

    // Only the real task list item should have a TaskCheckboxWidget!
    expect(checkboxWidgets).toHaveLength(1);
    const realTaskFrom = source.indexOf('- [ ] Real task') + 2;
    expect(checkboxWidgets[0]?.from).toBe(realTaskFrom);
  });

  it('does not hide escaped markdown delimiters like \\*literal\\*', () => {
    const source = '\\*literal\\*\n\n**bold**';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number; text: string }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to, text: source.slice(from, to) });
      }
    });

    // Must NOT replace the escaped \*
    expect(replacedRanges.some((r) => r.text.includes('\\*'))).toBe(false);
    expect(replacedRanges.some((r) => r.from === 0 || r.from === 1)).toBe(false);

    // Should replace ** for bold
    const boldIndex = source.indexOf('**bold**');
    expect(replacedRanges.some((r) => r.from === boldIndex)).toBe(true);
  });

  it('does not cross-pair adjacent formatting spans like **one** **two**', () => {
    const source = '**one** **two**';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to });
      }
    });

    // There should be 4 replaced delimiter ranges: [0, 2), [5, 7), [8, 10), [13, 15)
    expect(replacedRanges).toHaveLength(4);
    expect(replacedRanges[0]).toEqual({ from: 0, to: 2 });
    expect(replacedRanges[1]).toEqual({ from: 5, to: 7 });
    expect(replacedRanges[2]).toEqual({ from: 8, to: 10 });
    expect(replacedRanges[3]).toEqual({ from: 13, to: 15 });
  });

  it('dispatches on AST node.type to project nested blocks inside list items', () => {
    const source = '- Parent item\n  > Blockquote inside list item with **bold** text\n  - Nested list item with *italic*';
    const session = new MarkdownDocumentSession(source);
    const state = createSessionEditorState({
      session,
      surfaceId: 'visual-test',
      surfaceKind: 'visual'
    });

    const replacedRanges: Array<{ from: number; to: number }> = [];
    state.field(visualProjectionField).between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget) {
        replacedRanges.push({ from, to });
      }
    });

    // bold in blockquote inside item and italic in nested item should both have hidden delimiters
    const boldIndex = source.indexOf('**bold**');
    expect(replacedRanges.some((r) => r.from === boldIndex)).toBe(true);
    const italicIndex = source.indexOf('*italic*');
    expect(replacedRanges.some((r) => r.from === italicIndex)).toBe(true);
  });
});
