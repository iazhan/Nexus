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
  },
  '.cm-visual-hidden-delimiter': {
    display: 'none'
  },
  '.cm-visual-delimiter-revealed': {
    opacity: '0.7',
    color: '#94a3b8'
  },
  '.cm-visual-strike': {
    textDecoration: 'line-through'
  },
  '.cm-visual-horizontal-rule': {
    border: 'none',
    borderTop: '1px solid #334155',
    margin: '16px 0',
    cursor: 'pointer'
  },
  '.cm-visual-marker-inline-math': {
    color: '#93c5fd',
    backgroundColor: '#1e3a8a26'
  },
  '.cm-visual-marker-wikilink': {
    color: '#67e8f9',
    textDecoration: 'underline',
    textDecorationColor: '#0891b2'
  },
  '.cm-visual-marker-code-fence': {
    color: '#fdba74'
  },
  '.cm-visual-marker-block-math': {
    color: '#bfdbfe',
    backgroundColor: '#17255433'
  },
  '.cm-visual-task-checkbox': {
    marginRight: '6px',
    verticalAlign: 'middle',
    cursor: 'pointer',
    accentColor: '#3b82f6'
  },
  '.cm-visual-drag-handle': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '12px',
    height: '16px',
    marginRight: '6px',
    cursor: 'grab',
    userSelect: 'none',
    color: '#64748b',
    opacity: '0',
    transition: 'opacity 0.15s ease-in-out',
    verticalAlign: 'middle'
  },
  '.cm-line:hover .cm-visual-drag-handle, .cm-visual-drag-handle:hover, .cm-visual-drag-handle.is-dragging': {
    opacity: '1'
  },
  '.cm-visual-drag-handle.is-dragging': {
    cursor: 'grabbing',
    color: '#60a5fa'
  },
  '.cm-visual-drag-handle.disabled': {
    cursor: 'not-allowed',
    opacity: '0.3 !important',
    pointerEvents: 'none'
  },
  '.cm-visual-drop-target': {
    borderTop: '2px solid #3b82f6'
  },
  // Inline edit widgets & popover styles
  '.cm-inline-edit-popover': {
    position: 'absolute',
    zIndex: '150',
    backgroundColor: '#1a1c24',
    color: '#e2e8f0',
    border: '1px solid #333745',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: '260px',
    maxWidth: '380px'
  },
  '.cm-inline-edit-field': {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px'
  },
  '.cm-inline-edit-label': {
    fontSize: '11px',
    color: '#94a3b8',
    fontWeight: '500'
  },
  '.cm-inline-edit-popover input': {
    backgroundColor: '#121318',
    color: '#f1f5f9',
    border: '1px solid #333745',
    borderRadius: '4px',
    padding: '5px 8px',
    fontSize: '13px',
    outline: 'none'
  },
  '.cm-inline-edit-popover input:focus': {
    borderColor: '#3b82f6'
  },
  '.cm-inline-edit-actions': {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
    marginTop: '4px'
  },
  '.cm-inline-edit-actions button, .cm-image-upload-btn': {
    backgroundColor: '#262936',
    color: '#cbd5e1',
    border: '1px solid #373b4d',
    borderRadius: '4px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer'
  },
  '.cm-inline-edit-actions button:hover, .cm-image-upload-btn:hover': {
    backgroundColor: '#323647'
  },
  '.cm-inline-edit-save': {
    backgroundColor: '#2563eb !important',
    color: '#ffffff !important',
    borderColor: '#3b82f6 !important'
  },
  '.cm-inline-edit-save:hover': {
    backgroundColor: '#1d4ed8 !important'
  },
  '.cm-inline-edit-error': {
    color: '#f87171',
    fontSize: '11px',
    lineHeight: '1.4'
  },
  '.cm-visual-link': {
    color: '#60a5fa',
    textDecoration: 'underline',
    cursor: 'pointer'
  },
  '.cm-visual-link-blocked': {
    color: '#94a3b8',
    textDecoration: 'line-through',
    cursor: 'not-allowed',
    opacity: '0.6'
  },
  '.cm-visual-image': {
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    verticalAlign: 'middle'
  },
  '.cm-visual-image-blocked': {
    opacity: '0.5',
    cursor: 'not-allowed',
    filter: 'grayscale(1)'
  },
  '.cm-visual-image-placeholder': {
    display: 'inline-block',
    padding: '2px 6px',
    backgroundColor: '#1e293b',
    color: '#94a3b8',
    borderRadius: '4px',
    fontSize: '12px'
  },
  '.cm-visual-inline-math': {
    color: '#93c5fd',
    backgroundColor: '#1e3a8a26',
    borderRadius: '3px',
    padding: '1px 3px',
    cursor: 'pointer'
  },
  '.cm-visual-inline-code': {
    color: '#a5f3fc',
    backgroundColor: '#1e293b66',
    borderRadius: '3px',
    padding: '1px 4px',
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  '.cm-visual-wikilink': {
    color: '#67e8f9',
    textDecoration: 'underline',
    textDecorationColor: '#0891b2',
    backgroundColor: '#0e749022',
    borderRadius: '3px',
    padding: '1px 3px',
    cursor: 'pointer'
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
