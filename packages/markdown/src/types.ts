/**
 * UTF-16 code unit range in the source Markdown document.
 * Half-open interval: [from, to), where 0 <= from <= to <= source.length.
 */
export interface SourceRange {
  from: number;
  to: number;
}

/**
 * Common properties guaranteed across all Markdown AST nodes.
 */
export interface MarkdownBaseNode {
  range: SourceRange;
  raw: string;
  opaque?: boolean;
  block?: boolean;
  /**
   * Transient modification flag. When true, serializer will bypass cached raw text
   * and reconstruct from AST while preserving unmodified siblings.
   */
  dirty?: boolean;
  /**
   * Alias for dirty flag for backwards/alternative contract compatibility.
   */
  modified?: boolean;
}

export type MarkdownInlineNode =
  | ({ type: 'text'; value: string; escaped?: boolean } & MarkdownBaseNode)
  | ({ type: 'bold'; children: MarkdownInlineNode[] } & MarkdownBaseNode)
  | ({ type: 'italic'; children: MarkdownInlineNode[] } & MarkdownBaseNode)
  | ({ type: 'inline-code'; value: string } & MarkdownBaseNode)
  | ({
      type: 'link';
      href: string;
      title?: string;
      safeHref: string | null;
      isBlocked?: boolean;
      children: MarkdownInlineNode[];
    } & MarkdownBaseNode)
  | ({
      type: 'image';
      src: string;
      alt: string;
      title?: string;
      safeSrc: string | null;
      isBlocked?: boolean;
    } & MarkdownBaseNode)
  | ({ type: 'inline-math'; formula: string } & MarkdownBaseNode)
  | ({ type: 'wikilink'; target: string; alias?: string } & MarkdownBaseNode)
  | ({ type: 'raw'; value: string } & MarkdownBaseNode);

export interface MarkdownListItem extends MarkdownBaseNode {
  type: 'list-item';
  task?: boolean;
  checked?: boolean;
  children: (MarkdownInlineNode | MarkdownBlockNode)[];
}

export type MarkdownBlockNode =
  | ({
      type: 'heading';
      depth: 1 | 2 | 3 | 4 | 5 | 6;
      children: MarkdownInlineNode[];
    } & MarkdownBaseNode)
  | ({ type: 'paragraph'; children: MarkdownInlineNode[] } & MarkdownBaseNode)
  | ({ type: 'blockquote'; children: MarkdownBlockNode[] } & MarkdownBaseNode)
  | ({
      type: 'list';
      ordered: boolean;
      start?: number;
      items: MarkdownListItem[];
    } & MarkdownBaseNode)
  | ({
      type: 'code-block';
      language?: string;
      value: string;
    } & MarkdownBaseNode)
  | ({ type: 'block-math'; formula: string } & MarkdownBaseNode)
  | ({
      type: 'table';
      headers: MarkdownInlineNode[][];
      rows: MarkdownInlineNode[][][];
      align: ('left' | 'center' | 'right' | null)[];
    } & MarkdownBaseNode)
  | ({ type: 'raw'; value: string } & MarkdownBaseNode);

export interface MarkdownRoot extends MarkdownBaseNode {
  type: 'root';
  children: MarkdownBlockNode[];
}

export type MarkdownNode =
  | MarkdownRoot
  | MarkdownBlockNode
  | MarkdownInlineNode
  | MarkdownListItem;

export interface MarkdownDiagnostic {
  severity: 'warning' | 'error';
  message: string;
  from?: number;
  to?: number;
}

export interface MarkdownParseResult {
  source: string;
  root: MarkdownRoot;
  diagnostics: MarkdownDiagnostic[];
}
