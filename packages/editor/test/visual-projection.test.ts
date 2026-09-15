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
});
