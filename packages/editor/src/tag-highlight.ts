/**
 * `#标签` 的高亮装饰（Source 与 Visual 两个 surface 都装）。
 *
 * 扫描判据来自 `@nexus/core` 的 `scanTags()`，与索引层**同一份** —— 各写一份的话，
 * 漂移的症状是「编辑器里高亮着、标签面板里却没有」，不报错，只是让人以为功能坏了。
 * 代码块与行内代码里的 `#` 因此天然不高亮（`scanTags()` 已经跳过）。
 *
 * 用 mark 而不是 widget：`#标签` 是真实文档文本，不需要替换，替换反而会把它变成
 * 不可编辑的岛。点击行为由 `link-navigation.ts` 按 `data-tag` 接管。
 *
 * 装饰只画在**可见范围**内：标签位置每次改动都要重算（正则扫全文），但把结果铺成
 * 装饰没必要覆盖整篇文档 —— CodeMirror 也只渲染视口内的部分。
 */
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view';
import { scanTags, type TagMatch } from '@nexus/core';

/** 同一个标签会被文中多处引用，Decoration 按标签名复用，不必每处新建一个。 */
const marksByTag = new Map<string, Decoration>();

function markFor(tag: string): Decoration {
  let mark = marksByTag.get(tag);
  if (mark === undefined) {
    mark = Decoration.mark({
      class: 'cm-nexus-tag',
      attributes: { 'data-tag': tag }
    });
    marksByTag.set(tag, mark);
  }
  return mark;
}

class TagHighlightPlugin {
  private tags: readonly TagMatch[];
  public decorations: DecorationSet;

  public constructor(view: EditorView) {
    this.tags = scanTags(view.state.doc.toString());
    this.decorations = buildDecorations(view, this.tags);
  }

  public update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.tags = scanTags(update.state.doc.toString());
      this.decorations = buildDecorations(update.view, this.tags);
      return;
    }
    // 滚动只是换了可见范围，标签位置一个都没动 —— 重算正则是白付的。
    if (update.viewportChanged) {
      this.decorations = buildDecorations(update.view, this.tags);
    }
  }
}

/**
 * 只铺可见范围。`scanTags()` 按出现顺序返回，`visibleRanges` 也是升序，
 * 两层循环天然产出 `RangeSetBuilder` 要求的非递减顺序。
 */
function buildDecorations(view: EditorView, tags: readonly TagMatch[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const range of view.visibleRanges) {
    for (const tag of tags) {
      if (tag.to <= range.from) continue;
      if (tag.from >= range.to) break;
      builder.add(tag.from, tag.to, markFor(tag.tag));
    }
  }

  return builder.finish();
}

export const tagHighlightExtension = ViewPlugin.fromClass(TagHighlightPlugin, {
  decorations: (plugin) => plugin.decorations
});
