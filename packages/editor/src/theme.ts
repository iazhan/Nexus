import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const editorBaseTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: '#e2e8f0',
    backgroundColor: '#14151a',
    fontSize: '14px',
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace"
  },
  '.cm-content': {
    caretColor: '#60a5fa',
    padding: '12px 16px',
    lineHeight: '1.6'
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#60a5fa',
    borderLeftWidth: '2px'
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: '#2563eb44 !important'
  },
  '.cm-gutters': {
    backgroundColor: '#181920',
    color: '#64748b',
    borderRight: '1px solid #232530',
    paddingRight: '4px'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 12px',
    minWidth: '36px',
    textAlign: 'right'
  },
  '.cm-activeLine': {
    backgroundColor: '#1e202a66'
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#1e202a',
    color: '#94a3b8'
  },
  '.cm-panels': {
    backgroundColor: '#1a1c24',
    color: '#e2e8f0',
    borderBottom: '1px solid #2e3240'
  },
  '.cm-panels-top': {
    borderBottom: '1px solid #2e3240'
  },
  '.cm-search': {
    padding: '6px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  '.cm-search input': {
    backgroundColor: '#121318',
    color: '#f1f5f9',
    border: '1px solid #333745',
    borderRadius: '4px',
    padding: '4px 8px',
    fontSize: '12px',
    outline: 'none'
  },
  '.cm-search input:focus': {
    borderColor: '#3b82f6'
  },
  '.cm-search button': {
    backgroundColor: '#262936',
    color: '#cbd5e1',
    border: '1px solid #373b4d',
    borderRadius: '4px',
    padding: '3px 8px',
    fontSize: '12px',
    cursor: 'pointer'
  },
  '.cm-search button:hover': {
    backgroundColor: '#323647'
  },
  '.cm-search label': {
    fontSize: '12px',
    color: '#94a3b8'
  },
  // Custom marker styles
  '.cm-marker-inline-math': {
    color: '#93c5fd',
    backgroundColor: '#1e3a8a26',
    borderRadius: '3px',
    padding: '1px 3px'
  },
  '.cm-marker-block-math': {
    color: '#bfdbfe',
    backgroundColor: '#17255433',
    borderLeft: '3px solid #3b82f6',
    display: 'inline-block',
    width: '100%',
    padding: '2px 6px',
    borderRadius: '0 3px 3px 0'
  },
  '.cm-marker-wikilink': {
    color: '#67e8f9',
    textDecoration: 'underline',
    textDecorationColor: '#0891b2',
    backgroundColor: '#0e749022',
    borderRadius: '3px',
    padding: '1px 3px'
  },
  '.cm-marker-code-fence': {
    color: '#fdba74'
  }
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.4em', fontWeight: 'bold', color: '#f8fafc' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: 'bold', color: '#f1f5f9' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: 'bold', color: '#e2e8f0' },
  { tag: t.heading, fontWeight: 'bold', color: '#cbd5e1' },
  { tag: t.strong, fontWeight: 'bold', color: '#f1f5f9' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#e2e8f0' },
  { tag: t.link, color: '#60a5fa', textDecoration: 'underline' },
  { tag: t.url, color: '#38bdf8' },
  { tag: t.monospace, color: '#a5f3fc', backgroundColor: '#1e293b44' },
  { tag: t.quote, color: '#94a3b8', fontStyle: 'italic' },
  { tag: t.keyword, color: '#c084fc' },
  { tag: t.string, color: '#86efac' },
  { tag: t.comment, color: '#64748b', fontStyle: 'italic' }
]);

export const editorSyntaxHighlighting = syntaxHighlighting(markdownHighlightStyle, {
  fallback: true
});
