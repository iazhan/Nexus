import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Nexus Unified Theme using CSS Variables (Design Tokens)
export const nexusBaseTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--nexus-text-primary)",
    backgroundColor: "var(--nexus-bg-canvas)",
    fontSize: "14px",
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace"
  },
  ".cm-content": {
    caretColor: "var(--nexus-accent-primary)",
    padding: "12px 16px",
    lineHeight: "1.6"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--nexus-accent-primary)",
    borderLeftWidth: "2px"
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--nexus-selection-bg) !important"
  },
  ".cm-gutters": {
    backgroundColor: "var(--nexus-bg-surface)",
    color: "var(--nexus-text-muted)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    paddingRight: "4px"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 12px",
    minWidth: "36px",
    textAlign: "right"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--nexus-bg-surface-hover)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-secondary)"
  },

  // UI widgets and interactive elements
  ".cm-marker-inline-math": {
    color: "var(--nexus-accent-text)",
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderRadius: "3px",
    padding: "1px 3px"
  },
  ".cm-marker-block-math": {
    color: "var(--nexus-accent-text)",
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderLeft: "3px solid var(--nexus-accent-primary)",
    display: "inline-block",
    width: "100%",
    padding: "2px 6px",
    borderRadius: "0 3px 3px 0"
  },
  ".cm-marker-wikilink": {
    color: "var(--nexus-accent-text)",
    textDecoration: "underline",
    textDecorationColor: "var(--nexus-accent-primary)",
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderRadius: "3px",
    padding: "1px 3px"
  },
  ".cm-marker-code-fence": {
    color: "var(--nexus-syntax-string)"
  },
  ".cm-visual-hidden-delimiter": {
    display: "none"
  },
  ".cm-visual-delimiter-revealed": {
    opacity: "0.7",
    color: "var(--nexus-text-muted)"
  },
  ".cm-visual-strike": {
    textDecoration: "line-through"
  },
  ".cm-visual-horizontal-rule": {
    border: "none",
    borderTop: "1px solid var(--nexus-border-strong)",
    margin: "16px 0",
    cursor: "pointer"
  },
  
  // Extensions status
  ".nexus-ext-loading": {
    color: "var(--nexus-text-muted)",
    fontStyle: "italic",
    fontSize: "0.9em"
  },
  ".nexus-ext-error": {
    color: "#f87171", // Fixed error color
    backgroundColor: "rgba(248, 113, 113, 0.1)",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "0.9em",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px"
  },
  ".nexus-ext-retry": {
    backgroundColor: "var(--nexus-bg-surface-active)",
    color: "var(--nexus-text-primary)",
    border: "none",
    borderRadius: "3px",
    padding: "2px 6px",
    fontSize: "0.85em",
    cursor: "pointer"
  },
  ".nexus-ext-retry:hover": {
    backgroundColor: "var(--nexus-bg-surface-hover)"
  }
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.4em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading, fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.strong, fontWeight: "bold", color: "var(--nexus-text-primary)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--nexus-text-primary)" },
  { tag: t.link, color: "var(--nexus-syntax-url)", textDecoration: "underline" },
  { tag: t.url, color: "var(--nexus-syntax-url)" },
  { tag: t.monospace, color: "var(--nexus-syntax-inline-code-text)", backgroundColor: "var(--nexus-syntax-inline-code-bg)" },
  { tag: t.quote, color: "var(--nexus-text-secondary)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--nexus-syntax-keyword)" },
  { tag: t.string, color: "var(--nexus-syntax-string)" },
  { tag: t.comment, color: "var(--nexus-syntax-comment)", fontStyle: "italic" }
]);

export const editorSyntaxHighlighting = syntaxHighlighting(markdownHighlightStyle, {
  fallback: true
});

// Single unified theme exporter
export function getEditorTheme() {
  return [nexusBaseTheme, editorSyntaxHighlighting];
}
