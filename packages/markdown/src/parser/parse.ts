/**
 * 解析入口：用 marked 做词法分析，预处理 token 流，再交给块级映射器。
 */
import { marked } from 'marked';
import type { MarkdownDiagnostic, MarkdownParseResult } from '../types.js';
import { mapBlockTokens } from './block-mapper.js';

/**
 * Parses Markdown source text into an AST render model.
 * Always preserves raw source and generates diagnostics safely without throwing.
 */
export function parseMarkdown(source: string): MarkdownParseResult {
  if (!source || source.length === 0) {
    return {
      source,
      root: {
        type: 'root',
        children: [],
        range: { from: 0, to: 0 },
        raw: ''
      },
      diagnostics: []
    };
  }

  if (source.trim().length === 0) {
    return {
      source,
      root: {
        type: 'root',
        children: [],
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics: []
    };
  }

  const diagnostics: MarkdownDiagnostic[] = [];

  try {
    const tokens = marked.lexer(source, {
      gfm: true,
      breaks: false
    });

    const rootChildren = mapBlockTokens(tokens, source, diagnostics, 0);

    return {
      source,
      root: {
        type: 'root',
        children: rootChildren,
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      severity: 'error',
      message: `Markdown parsing error: ${message}`
    });

    // Fallback gracefully to raw block
    return {
      source,
      root: {
        type: 'root',
        children: [
          {
            type: 'raw',
            value: source,
            range: { from: 0, to: source.length },
            raw: source,
            opaque: true
          }
        ],
        range: { from: 0, to: source.length },
        raw: source
      },
      diagnostics
    };
  }
}
