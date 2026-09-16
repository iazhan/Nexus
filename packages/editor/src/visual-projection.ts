import { StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { parseMarkdown, type MarkdownBlockNode, type MarkdownInlineNode, type MarkdownListItem } from '@nexus/markdown';
import { findMarkdownMarkers } from './markdown-markers.js';

class HiddenDelimiterWidget extends WidgetType {
  public constructor(private readonly delimiter: string) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-visual-hidden-delimiter';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.delimiter = this.delimiter;
    return element;
  }

  public eq(other: WidgetType): boolean {
    return other instanceof HiddenDelimiterWidget && other.delimiter === this.delimiter;
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

interface ProjectionRange {
  from: number;
  to: number;
  decoration: Decoration;
}

export class TaskCheckboxWidget extends WidgetType {
  public constructor(
    public readonly checked: boolean,
    public readonly from: number,
    public readonly to: number
  ) {
    super();
  }

  public toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-visual-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');

    if (view.state.readOnly) {
      input.disabled = true;
    }

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('change', () => {
      if (view.state.readOnly) return;
      const current = view.state.doc.sliceString(this.from, this.to);
      const isCurrentlyChecked = current.toLowerCase().includes('x');
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: isCurrentlyChecked ? '[ ]' : '[x]'
        },
        userEvent: 'task.toggle'
      });
    });

    return input;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 构建最小 Visual surface 投影。
 * source 仍然是 EditorState.doc，视觉层只通过 decoration/widget 隐藏语法定界符。
 */
export function buildVisualProjection(source: string): DecorationSet {
  const ranges: ProjectionRange[] = [];

  for (const marker of findMarkdownMarkers(source)) {
    ranges.push({
      from: marker.from,
      to: marker.to,
      decoration: Decoration.mark({ class: `cm-visual-marker cm-visual-marker-${marker.type}` })
    });
  }

  const { root } = parseMarkdown(source);

  function walkInline(inlineNode: MarkdownInlineNode): void {
    if (inlineNode.type === 'bold') {
      const delim = inlineNode.raw.startsWith('**') ? '**' : (inlineNode.raw.startsWith('__') ? '__' : '**');
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'italic') {
      const delim = inlineNode.raw.startsWith('*') ? '*' : (inlineNode.raw.startsWith('_') ? '_' : '*');
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(delim) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'link') {
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    }
  }

  function walkBlock(blockNode: MarkdownBlockNode): void {
    if (blockNode.type === 'heading') {
      const match = blockNode.raw.match(/^([ \t]*)(#{1,6})/);
      if (match && match[2]) {
        const indentLen = (match[1] ?? '').length;
        const hashLen = match[2].length;
        const from = blockNode.range.from + indentLen;
        ranges.push({
          from,
          to: from + hashLen,
          decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(match[2]) })
        });
      }
      for (const child of blockNode.children) {
        walkInline(child);
      }
    } else if (blockNode.type === 'paragraph') {
      for (const child of blockNode.children) {
        walkInline(child);
      }
    } else if (blockNode.type === 'blockquote') {
      for (const child of blockNode.children) {
        walkBlock(child);
      }
    } else if (blockNode.type === 'list') {
      for (const item of blockNode.items) {
        walkListItem(item);
      }
    } else if (blockNode.type === 'table') {
      for (const headerRow of blockNode.headers) {
        for (const cell of headerRow) {
          walkInline(cell);
        }
      }
      for (const row of blockNode.rows) {
        for (const cellRow of row) {
          for (const cell of cellRow) {
            walkInline(cell);
          }
        }
      }
    }
    // code-block, block-math, raw: do not walk into their contents
  }

  function walkListItem(item: MarkdownListItem): void {
    if (item.task) {
      const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
      const match = firstLine.match(/^([ \t]*>(?:[ \t]*>)*)?([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(\[[ xX]\])/);
      if (match && match[3]) {
        const prefixLen = (match[1] ?? '').length + (match[2] ?? '').length;
        const from = item.range.from + prefixLen;
        const to = from + match[3].length;
        const isChecked = Boolean(item.checked);
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({ widget: new TaskCheckboxWidget(isChecked, from, to) })
        });
      }
    }

    const blockTypes = new Set(['heading', 'paragraph', 'blockquote', 'list', 'code-block', 'block-math', 'table']);
    for (const child of item.children) {
      if (blockTypes.has(child.type)) {
        walkBlock(child as MarkdownBlockNode);
      } else if (child.type !== 'raw') {
        walkInline(child as MarkdownInlineNode);
      }
    }
  }


  for (const block of root.children) {
    walkBlock(block);
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    builder.add(range.from, range.to, range.decoration);
  }
  return builder.finish();
}

/** Visual surface 的 source-aligned decoration field。 */
export const visualProjectionField = StateField.define<DecorationSet>({
  create(state) {
    return buildVisualProjection(state.doc.toString());
  },
  update(decorations, transaction) {
    if (!transaction.docChanged) return decorations;
    return buildVisualProjection(transaction.state.doc.toString());
  },
  provide: (field) => EditorView.decorations.from(field)
});

/** Visual surface 的基础扩展；不创建第二份文档。 */
export const visualProjectionExtensions: Extension[] = [visualProjectionField];
