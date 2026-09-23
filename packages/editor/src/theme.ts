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
    padding: "12px 16px 12px 36px",
    lineHeight: "1.6"
  },
  ".cm-line": {
    position: "relative"
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
  ".cm-visual-drag-handle": {
    position: "absolute",
    left: "-26px",
    top: "calc(0.5lh)",
    transform: "translateY(-50%)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "18px",
    color: "var(--nexus-text-muted)",
    cursor: "grab",
    userSelect: "none",
    opacity: "0",
    transition: "opacity 0.15s ease, color 0.15s ease",
    zIndex: "5"
  },
  ".cm-visual-code-header-line > .cm-visual-drag-handle": {
    top: "50%"
  },
  ".cm-visual-drag-handle::after": {
    content: "''",
    position: "absolute",
    top: "0",
    bottom: "0",
    right: "-10px",
    width: "10px"
  },
  ".cm-line:hover > .cm-visual-drag-handle, .cm-visual-drag-handle:focus-within, .cm-visual-drag-handle.is-dragging": {
    opacity: "0.5"
  },
  ".cm-visual-drag-handle:hover": {
    opacity: "1",
    color: "var(--nexus-text-primary)"
  },
  ".cm-visual-drag-handle.disabled": {
    cursor: "not-allowed",
    opacity: "0 !important"
  },
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
  ".cm-visual-quote-marker": {
    color: "var(--nexus-text-muted)",
    opacity: "0.8",
    fontWeight: "500"
  },
  ".cm-visual-strike": {
    textDecoration: "line-through"
  },
  ".cm-visual-hr-container": {
    display: "block",
    boxSizing: "border-box",
    padding: "16px 0",
    cursor: "pointer"
  },
  ".cm-visual-horizontal-rule": {
    border: "none",
    borderTop: "1px solid var(--nexus-border-strong)",
    margin: "0",
    width: "100%",
    cursor: "pointer"
  },

  // Blockquote styling
  ".cm-visual-blockquote-line": {
    borderLeft: "3.5px solid var(--nexus-accent-primary)",
    backgroundColor: "var(--nexus-bg-quote, var(--nexus-status-info-bg, rgba(59, 130, 246, 0.08)))",
    paddingLeft: "16px",
    paddingRight: "16px",
    position: "relative"
  },
  ".cm-visual-blockquote-first-line": {
    borderTopRightRadius: "6px",
    paddingTop: "6px"
  },
  ".cm-visual-blockquote-last-line": {
    borderBottomRightRadius: "6px",
    paddingBottom: "6px"
  },

  // Code block line decorations and styling
  ".cm-visual-code-line": {
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
    paddingLeft: "12px",
    paddingRight: "12px"
  },
  ".cm-visual-code-header-line": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    backgroundColor: "var(--nexus-bg-surface, #f8fafc)",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "28px",
    minHeight: "28px",
    lineHeight: "22px",
    boxSizing: "border-box"
  },
  ".cm-visual-code-header-line .cm-widgetBuffer, .cm-visual-code-closing-line .cm-widgetBuffer": {
    display: "none !important",
    width: "0 !important",
    height: "0 !important"
  },
  ".cm-code-header-widget": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: "100%",
    lineHeight: "22px",
    userSelect: "none"
  },
  ".cm-code-header-left": {
    display: "flex",
    alignItems: "center",
    gap: "8px"
  },
  ".cm-code-line-count": {
    fontSize: "0.75em",
    color: "var(--nexus-text-muted)",
    userSelect: "none",
    fontFamily: "inherit"
  },
  ".cm-code-language-select": {
    appearance: "none",
    WebkitAppearance: "none",
    opacity: "0.85",
    pointerEvents: "auto",
    backgroundColor: "transparent",
    color: "var(--nexus-text-muted)",
    border: "none",
    borderRadius: "3px",
    height: "20px",
    padding: "0",
    fontSize: "0.75em",
    fontWeight: "600",
    textTransform: "uppercase",
    fontFamily: "inherit",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "color 0.15s ease"
  },
  ".cm-code-language-select:hover": {
    color: "var(--nexus-text-primary)"
  },
  ".cm-code-copy-btn": {
    opacity: "0",
    pointerEvents: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary)",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "3px",
    height: "20px",
    padding: "0 6px",
    fontSize: "0.75em",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "opacity 0.15s ease-out, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease"
  },
  ".cm-visual-code-header-line:hover .cm-code-copy-btn, .cm-visual-code-header-line[data-code-block-hovered='true'] .cm-code-copy-btn, .cm-code-header-widget:focus-within .cm-code-copy-btn": {
    opacity: "1 !important",
    pointerEvents: "auto !important"
  },
  ".cm-code-copy-btn:hover": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-primary)"
  },
  ".cm-code-copy-btn.copied": {
    color: "var(--nexus-status-success-text, #065f46)",
    borderColor: "var(--nexus-status-success-border, #34d399)"
  },
  ".cm-code-copy-icon": {
    flexShrink: "0",
    transition: "transform 0.15s ease"
  },
  ".cm-code-copy-check": {
    color: "var(--nexus-status-success-text, #065f46)"
  },
  ".cm-visual-code-content-line": {
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    position: "relative"
  },
  ".cm-visual-code-content-line[data-code-line-number]::before": {
    content: "attr(data-code-line-number)",
    display: "inline-block",
    minWidth: "2.5ch",
    marginRight: "12px",
    paddingRight: "8px",
    borderRight: "1px solid var(--nexus-border-default, #d4d4d4)",
    color: "var(--nexus-text-muted)",
    textAlign: "right",
    userSelect: "none",
    fontSize: "0.85em"
  },
  ".cm-visual-code-closing-line": {
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    height: "22px",
    minHeight: "22px",
    lineHeight: "22px"
  },
  // 缩进式（无围栏）代码块没有 header/closing 行，
  // 由首个与末尾内容行补出卡片上/下边框与圆角，保持与围栏代码块一致的外观。
  ".cm-visual-code-plain-first-line": {
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingTop: "6px"
  },
  ".cm-visual-code-plain-last-line": {
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    paddingBottom: "6px"
  },
  ".cm-code-exit-widget": {
    display: "block",
    height: "100%",
    width: "100%",
    cursor: "text"
  },

  // Quote-nested code block styling:
  // The outer .cm-line maintains the continuous blockquote blue accent bar and light-blue background.
  // The code block is rendered as an inner card embedded inside the blockquote container.
  ".cm-visual-code-line.cm-visual-code-quote-nested": {
    borderLeft: "3.5px solid var(--nexus-accent-primary)",
    borderRight: "none",
    backgroundColor: "var(--nexus-bg-quote, var(--nexus-status-info-bg, rgba(59, 130, 246, 0.08)))",
    paddingLeft: "16px",
    paddingRight: "16px",
    position: "relative"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-header-line": {
    display: "block",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-primary)",
    borderRadius: "0",
    backgroundColor: "var(--nexus-bg-quote, var(--nexus-status-info-bg, rgba(59, 130, 246, 0.08)))",
    padding: "8px 16px 0 16px",
    height: "auto",
    minHeight: "36px",
    lineHeight: "normal",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-header-line .cm-code-header-widget": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "var(--nexus-bg-surface, #f8fafc)",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "28px",
    minHeight: "28px",
    lineHeight: "22px",
    boxSizing: "border-box",
    width: "100%"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-content-line": {
    isolation: "isolate",
    position: "relative",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-primary)",
    backgroundColor: "var(--nexus-bg-quote, var(--nexus-status-info-bg, rgba(59, 130, 246, 0.08)))",
    paddingLeft: "28px",
    paddingRight: "28px",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-content-line::after": {
    content: "''",
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "16px",
    right: "16px",
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    zIndex: "-1",
    pointerEvents: "none",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-closing-line": {
    display: "block",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-primary)",
    borderRadius: "0",
    backgroundColor: "var(--nexus-bg-quote, var(--nexus-status-info-bg, rgba(59, 130, 246, 0.08)))",
    padding: "0 16px 8px 16px",
    height: "auto",
    minHeight: "0",
    lineHeight: "0",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-closing-line .cm-code-exit-widget": {
    display: "block",
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    borderTop: "none",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    height: "8px",
    minHeight: "8px",
    lineHeight: "8px",
    boxSizing: "border-box",
    width: "100%",
    cursor: "pointer"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-first-line": {
    paddingTop: "8px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-first-line::after": {
    top: "8px",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-last-line": {
    paddingBottom: "8px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-last-line::after": {
    bottom: "8px",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px"
  },
  // Table visual styling & floating controls
  ".cm-visual-table-container": {
    position: "relative",
    margin: "24px 0",
    overflow: "visible",
    boxSizing: "border-box",
    maxWidth: "100%"
  },
  ".cm-visual-table-scroll": {
    position: "relative",
    overflowX: "auto",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    borderRadius: "6px",
    "&::-webkit-scrollbar": {
      height: "6px",
      width: "6px"
    },
    "&::-webkit-scrollbar-track": {
      background: "transparent"
    },
    "&::-webkit-scrollbar-thumb": {
      background: "var(--nexus-border-subtle, rgba(0, 0, 0, 0.15))",
      borderRadius: "3px"
    },
    "&::-webkit-scrollbar-thumb:hover": {
      background: "var(--nexus-border-strong, rgba(0, 0, 0, 0.3))"
    }
  },
  ".cm-visual-table": {
    borderCollapse: "separate",
    borderSpacing: "0",
    width: "100%",
    border: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    tableLayout: "auto"
  },
  ".cm-visual-table th": {
    backgroundColor: "var(--nexus-bg-surface, #f8fafc)",
    color: "var(--nexus-text-primary, #1e293b)",
    fontWeight: "600",
    padding: "8px 12px",
    borderBottom: "2px solid var(--nexus-border-strong, #cbd5e1)",
    borderRight: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    minWidth: "3.5em",
    minHeight: "1.6em",
    textAlign: "left",
    boxSizing: "border-box",
    cursor: "cell",
    userSelect: "text",
    "&:last-child": {
      borderRight: "none"
    }
  },
  ".cm-visual-table td": {
    padding: "8px 12px",
    borderBottom: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    borderRight: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    minWidth: "3.5em",
    minHeight: "1.6em",
    color: "var(--nexus-text-primary, #1e293b)",
    boxSizing: "border-box",
    cursor: "cell",
    userSelect: "text",
    transition: "background-color 0.15s ease, outline 0.1s ease",
    "&:last-child": {
      borderRight: "none"
    },
    "&:hover": {
      backgroundColor: "var(--nexus-bg-surface-hover, rgba(0, 0, 0, 0.03))"
    },
    "&.is-active, &:focus-within": {
      outline: "2px solid var(--nexus-accent-primary, #3b82f6)",
      outlineOffset: "-2px"
    }
  },
  ".cm-visual-table tr:last-child td": {
    borderBottom: "none"
  },
  ".cm-table-cell-placeholder": {
    color: "var(--nexus-text-muted, #94a3b8)",
    opacity: "0.4",
    pointerEvents: "none",
    userSelect: "none",
    display: "inline-block",
    minWidth: "1em",
    minHeight: "1.2em"
  },
  ".cm-table-cell-editor": {
    width: "100%",
    boxSizing: "border-box",
    background: "transparent",
    border: "none",
    outline: "none",
    color: "inherit",
    font: "inherit",
    padding: "0",
    margin: "0"
  },

  // Floating toolbar
  ".cm-table-toolbar, .cm-table-floating-toolbar": {
    position: "absolute",
    top: "-38px",
    left: "0",
    zIndex: "20",
    display: "flex",
    alignItems: "center",
    gap: "3px",
    padding: "3px 6px",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-surface, #f8fafc)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    border: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.15s ease, transform 0.15s ease",
    transform: "translateY(2px)"
  },
  ".cm-visual-table-container:hover .cm-table-toolbar, .cm-visual-table-container:hover .cm-table-floating-toolbar, .cm-visual-table-container:focus-within .cm-table-toolbar, .cm-visual-table-container:focus-within .cm-table-floating-toolbar, .cm-table-toolbar.is-open, .cm-table-floating-toolbar.is-open": {
    opacity: "1 !important",
    pointerEvents: "auto !important",
    transform: "translateY(0)"
  },
  ".cm-table-toolbar button, .cm-table-floating-toolbar button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    height: "24px",
    padding: "0 6px",
    borderRadius: "4px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary, #64748b)",
    fontSize: "12px",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "all 0.15s ease",
    "&:hover:not(:disabled)": {
      backgroundColor: "var(--nexus-bg-surface-hover, rgba(0, 0, 0, 0.05))",
      color: "var(--nexus-text-primary, #0f172a)"
    },
    "&:disabled": {
      opacity: "0.35",
      cursor: "not-allowed"
    },
    "&.is-active": {
      backgroundColor: "var(--nexus-bg-surface-active, rgba(59, 130, 246, 0.1))",
      color: "var(--nexus-accent-primary, #3b82f6)",
      borderColor: "var(--nexus-border-subtle, #e2e8f0)",
      fontWeight: "500"
    }
  },
  ".cm-table-btn-del-table": {
    color: "var(--nexus-status-error, #ef4444) !important",
    "&:hover:not(:disabled)": {
      backgroundColor: "var(--nexus-status-error-bg, rgba(239, 68, 68, 0.1)) !important",
      color: "var(--nexus-status-error, #ef4444) !important"
    }
  },

  // 8x10 Grid Resizer popover
  ".cm-table-grid-popover": {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: "0",
    zIndex: "35",
    backgroundColor: "var(--nexus-bg-surface, #ffffff)",
    border: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    borderRadius: "8px",
    padding: "8px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    display: "none",
    flexDirection: "column",
    gap: "6px",
    userSelect: "none",
    "&.is-visible": {
      display: "flex"
    }
  },
  ".cm-table-grid-matrix": {
    display: "grid",
    gridTemplateColumns: "repeat(8, 16px)",
    gridGap: "3px"
  },
  ".cm-table-grid-cell": {
    width: "16px",
    height: "16px",
    borderRadius: "2px",
    border: "1px solid var(--nexus-border-subtle, #cbd5e1)",
    backgroundColor: "var(--nexus-bg-canvas, #ffffff)",
    cursor: "pointer",
    transition: "background-color 0.1s ease, border-color 0.1s ease",
    "&.is-highlighted": {
      backgroundColor: "var(--nexus-accent-primary, #3b82f6)",
      borderColor: "var(--nexus-accent-primary, #3b82f6)",
      opacity: "0.85"
    }
  },
  ".cm-table-grid-footer": {
    fontSize: "11px",
    color: "var(--nexus-text-muted, #94a3b8)",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums"
  },

  // Floating hover handles (+ buttons)
  ".cm-table-handle-add-col": {
    position: "absolute",
    right: "-14px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "22px",
    height: "28px",
    borderRadius: "4px",
    backgroundColor: "var(--nexus-bg-surface, #ffffff)",
    border: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease",
    zIndex: "15",
    fontSize: "14px",
    fontWeight: "bold",
    color: "var(--nexus-text-secondary, #64748b)"
  },
  ".cm-visual-table-container:hover .cm-table-handle-add-col": {
    opacity: "0.75"
  },
  ".cm-table-handle-add-col:hover": {
    opacity: "1 !important",
    backgroundColor: "var(--nexus-bg-surface-hover, #f1f5f9)",
    color: "var(--nexus-accent-primary, #3b82f6)"
  },
  ".cm-table-handle-add-row": {
    position: "absolute",
    bottom: "-14px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "28px",
    height: "22px",
    borderRadius: "4px",
    backgroundColor: "var(--nexus-bg-surface, #ffffff)",
    border: "1px solid var(--nexus-border-subtle, #e2e8f0)",
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease",
    zIndex: "15",
    fontSize: "14px",
    fontWeight: "bold",
    color: "var(--nexus-text-secondary, #64748b)"
  },
  ".cm-visual-table-container:hover .cm-table-handle-add-row": {
    opacity: "0.75"
  },
  ".cm-table-handle-add-row:hover": {
    opacity: "1 !important",
    backgroundColor: "var(--nexus-bg-surface-hover, #f1f5f9)",
    color: "var(--nexus-accent-primary, #3b82f6)"
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
  },
  ".tok-keyword, .cm-prism-token.tok-keyword": { color: "var(--nexus-syntax-keyword, #0000ff)" },
  ".tok-control, .cm-prism-token.tok-control": { color: "var(--nexus-syntax-control, #af00db)" },
  ".tok-string, .cm-prism-token.tok-string": { color: "var(--nexus-syntax-string, #a31515)" },
  ".tok-comment, .cm-prism-token.tok-comment": { color: "var(--nexus-syntax-comment, #008000)", fontStyle: "italic" },
  ".tok-number, .cm-prism-token.tok-number": { color: "var(--nexus-syntax-number, #098658)" },
  ".tok-boolean, .cm-prism-token.tok-boolean": { color: "var(--nexus-syntax-bool, #0000ff)" },
  ".tok-function, .cm-prism-token.tok-function": { color: "var(--nexus-syntax-function, #795e26)" },
  ".tok-builtin, .cm-prism-token.tok-builtin": { color: "var(--nexus-syntax-builtin, #001080)" },
  ".tok-operator, .cm-prism-token.tok-operator": { color: "var(--nexus-syntax-operator, #000000)" },
  ".tok-punctuation, .cm-prism-token.tok-punctuation": { color: "var(--nexus-syntax-punctuation, #333333)" },
  ".tok-type, .cm-prism-token.tok-class-name": { color: "var(--nexus-syntax-type, #267f99)" },
  ".tok-property, .cm-prism-token.tok-property": { color: "var(--nexus-syntax-property, #001080)" },
  ".tok-variable, .cm-prism-token.tok-variable": { color: "var(--nexus-syntax-variable, #001080)" },
  ".tok-regex, .cm-prism-token.tok-regex": { color: "var(--nexus-syntax-string, #a31515)" },

  // Prism fallback token coverage.
  // Prism emits many more token types than Lezer. Any type without an explicit
  // rule would inherit the code-fence marker colour, making a highlighted block
  // look uniformly red/grey. Each entry below mirrors its Lezer counterpart.
  ".tok-function-definition, .cm-prism-token.tok-function-definition, .tok-macro, .cm-prism-token.tok-macro, .tok-function-variable, .cm-prism-token.tok-function-variable": { color: "var(--nexus-syntax-function, #795e26)" },
  ".tok-key, .cm-prism-token.tok-key, .tok-attr-name, .cm-prism-token.tok-attr-name, .tok-title, .cm-prism-token.tok-title, .tok-property-access, .cm-prism-token.tok-property-access, .tok-literal-property, .cm-prism-token.tok-literal-property": { color: "var(--nexus-syntax-property, #001080)" },
  ".tok-attr-value, .cm-prism-token.tok-attr-value, .tok-char, .cm-prism-token.tok-char, .tok-entity, .cm-prism-token.tok-entity, .tok-interpolation, .cm-prism-token.tok-interpolation, .tok-triple-quoted-string, .cm-prism-token.tok-triple-quoted-string, .tok-string-property, .cm-prism-token.tok-string-property, .tok-template-string, .cm-prism-token.tok-template-string, .tok-value, .cm-prism-token.tok-value": { color: "var(--nexus-syntax-string, #a31515)" },
  ".tok-tag, .cm-prism-token.tok-tag, .tok-selector, .cm-prism-token.tok-selector, .tok-namespace, .cm-prism-token.tok-namespace, .tok-generics, .cm-prism-token.tok-generics, .tok-maybe-class-name, .cm-prism-token.tok-maybe-class-name, .tok-class-reference, .cm-prism-token.tok-class-reference, .cm-prism-token.tok-type, .cm-prism-token.tok-section": { color: "var(--nexus-syntax-type, #267f99)" },
  ".tok-atrule, .cm-prism-token.tok-atrule, .tok-important, .cm-prism-token.tok-important, .tok-annotation, .cm-prism-token.tok-annotation, .tok-attribute, .cm-prism-token.tok-attribute, .tok-decorator, .cm-prism-token.tok-decorator": { color: "var(--nexus-syntax-control, #af00db)" },
  ".tok-constant, .cm-prism-token.tok-constant, .tok-symbol, .cm-prism-token.tok-symbol, .tok-version, .cm-prism-token.tok-version, .tok-datetime, .cm-prism-token.tok-datetime, .tok-lifetime, .cm-prism-token.tok-lifetime": { color: "var(--nexus-syntax-number, #098658)" },
  ".tok-directive, .cm-prism-token.tok-directive, .tok-method, .cm-prism-token.tok-method, .tok-operation, .cm-prism-token.tok-operation, .tok-rule, .cm-prism-token.tok-rule": { color: "var(--nexus-syntax-keyword, #0000ff)" },
  ".tok-label, .cm-prism-token.tok-label, .tok-parameter, .cm-prism-token.tok-parameter, .tok-package, .cm-prism-token.tok-package, .tok-global-variable, .cm-prism-token.tok-global-variable, .tok-argument, .cm-prism-token.tok-argument": { color: "var(--nexus-syntax-variable, #001080)" },
  ".tok-delimiter, .cm-prism-token.tok-delimiter, .tok-punctuator, .cm-prism-token.tok-punctuator": { color: "var(--nexus-syntax-punctuation, #333333)" },
  ".tok-url, .cm-prism-token.tok-url": { color: "var(--nexus-syntax-url, #007acc)" },
  ".tok-doctype, .cm-prism-token.tok-doctype, .tok-prolog, .cm-prism-token.tok-prolog, .tok-cdata, .cm-prism-token.tok-cdata": { color: "var(--nexus-syntax-comment, #008000)" },
  ".tok-inserted, .cm-prism-token.tok-inserted": { color: "var(--nexus-status-success-text, #065f46)" },
  ".tok-deleted, .cm-prism-token.tok-deleted": { color: "var(--nexus-status-error-text, #991b1b)" },
  ".tok-bold, .cm-prism-token.tok-bold": { fontWeight: "bold" },
  ".tok-italic, .cm-prism-token.tok-italic": { fontStyle: "italic" }
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.4em", fontWeight: "bold", color: "var(--nexus-syntax-heading, #000000)" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "bold", color: "var(--nexus-syntax-heading, #000000)" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "bold", color: "var(--nexus-syntax-heading, #000000)" },
  { tag: t.heading, fontWeight: "bold", color: "var(--nexus-syntax-heading, #000000)" },
  { tag: t.strong, fontWeight: "bold", color: "var(--nexus-text-primary, #333333)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--nexus-text-primary, #333333)" },
  { tag: t.link, color: "var(--nexus-syntax-url, #007acc)", textDecoration: "underline" },
  { tag: t.url, color: "var(--nexus-syntax-url, #007acc)" },
  { tag: t.monospace, color: "var(--nexus-syntax-inline-code-text, #24292e)", backgroundColor: "var(--nexus-syntax-inline-code-bg, rgba(27,31,35,0.05))" },
  { tag: t.quote, color: "var(--nexus-text-secondary, #666666)", fontStyle: "italic" },
  { tag: t.controlKeyword, class: "tok-control", color: "var(--nexus-syntax-control, #af00db)" },
  { tag: t.moduleKeyword, class: "tok-control", color: "var(--nexus-syntax-module, #af00db)" },
  { tag: [t.keyword, t.self, t.modifier, t.null, t.atom], class: "tok-keyword", color: "var(--nexus-syntax-keyword, #0000ff)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], class: "tok-string", color: "var(--nexus-syntax-string, #a31515)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment", color: "var(--nexus-syntax-comment, #008000)", fontStyle: "italic" },
  { tag: t.number, class: "tok-number", color: "var(--nexus-syntax-number, #098658)" },
  { tag: t.bool, class: "tok-boolean", color: "var(--nexus-syntax-bool, #0000ff)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], class: "tok-function", color: "var(--nexus-syntax-function, #795e26)" },
  { tag: t.standard(t.variableName), class: "tok-builtin", color: "var(--nexus-syntax-builtin, #001080)" },
  { tag: [t.propertyName, t.labelName], class: "tok-property", color: "var(--nexus-syntax-property, #001080)" },
  { tag: [t.variableName, t.definition(t.variableName)], class: "tok-variable", color: "var(--nexus-syntax-variable, #001080)" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type", color: "var(--nexus-syntax-type, #267f99)" },
  { tag: t.operator, class: "tok-operator", color: "var(--nexus-syntax-operator, #000000)" },
  { tag: t.punctuation, class: "tok-punctuation", color: "var(--nexus-syntax-punctuation, #333333)" }
]);

export const editorSyntaxHighlighting = syntaxHighlighting(markdownHighlightStyle, {
  fallback: true
});

// Single unified theme exporter
export function getEditorTheme() {
  return [nexusBaseTheme, editorSyntaxHighlighting];
}
