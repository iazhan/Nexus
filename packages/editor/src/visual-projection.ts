import { StateField, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
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

function addDelimiterPair(ranges: ProjectionRange[], source: string, open: string, close: string, from: number): void {
  const contentStart = from + open.length;
  const closeFrom = source.indexOf(close, contentStart);
  if (closeFrom <= contentStart) return;

  ranges.push({
    from,
    to: contentStart,
    decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(open) })
  });
  ranges.push({
    from: closeFrom,
    to: closeFrom + close.length,
    decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(close) })
  });
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

  const delimiterPattern = /\*\*|__|~~|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g;
  for (const match of source.matchAll(delimiterPattern)) {
    const delimiter = match[0];
    const from = match.index;
    if (from === undefined) continue;
    const close = delimiter;
    if (delimiter === '**' || delimiter === '__' || delimiter === '~~') {
      addDelimiterPair(ranges, source, delimiter, close, from);
    }
  }

  for (const match of source.matchAll(/^( {0,3})(#{1,6})(?=\s)/gm)) {
    const indent = match[1];
    const hashes = match[2];
    if (indent === undefined || hashes === undefined) continue;
    const from = match.index + indent.length;
    ranges.push({
      from,
      to: from + hashes.length,
      decoration: Decoration.replace({ widget: new HiddenDelimiterWidget(hashes) })
    });
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
