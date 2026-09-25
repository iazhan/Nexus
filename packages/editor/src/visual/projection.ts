import { RangeSetBuilder, EditorSelection } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
  type SourceRange
} from '@nexus/markdown';
import { findMarkdownMarkers } from '../markdown-markers.js';
import { isMermaidLanguage } from '../extension-triggers.js';
import {
  LinkWidget,
  ImageWidget,
  InlineMathWidget,
  InlineCodeWidget,
  WikiLinkWidget,
  getInlineNodePlainText
} from '../inline-edit.js';
import { splitTableLines } from '../table-edit.js';
import { walkBlockNodes } from '../ast-walker.js';
import { EMPTY_MERMAID_PINS, type MermaidPreviewPin } from './state.js';
import {
  findLinkTextEnd,
  hasFenceOpener,
  isClosedFence,
  isInsideQuotePrefix,
  isMarkerAtLineEnd,
  leadingQuoteMarkerLength,
  resolveDocumentAssetUrl
} from './source-analysis.js';
import {
  DelimiterWidget,
  HorizontalRuleWidget,
  ListMarkerWidget,
  TaskCheckboxWidget
} from './widgets/inline.js';
import { TableBlockWidget } from './widgets/table-block.js';
import {
  CodeBlockExitWidget,
  CodeBlockHeaderWidget,
  CodeBlockWidget
} from './widgets/code-block.js';
import { BlockMathPreviewWidget, BlockMathWidget } from './widgets/math.js';
import { RawBlockWidget } from './widgets/raw.js';

interface ProjectionRange {
  from: number;
  to: number;
  decoration: Decoration;
}

/**
 * 构建最小 Visual surface 投影。
 * source 仍然是 EditorState.doc，视觉层只通过 decoration/widget 隐藏语法定界符。
 */
export function buildVisualProjection(
  source: string,
  selection: EditorSelection | null = null,
  isFocused: boolean = false,
  documentDirectory: string | null = null,
  locale: string = 'zh-CN',
  mermaidPins: ReadonlyMap<number, MermaidPreviewPin> = EMPTY_MERMAID_PINS
): DecorationSet {
  const ranges: ProjectionRange[] = [];
  const { root } = parseMarkdown(source);

  const selFrom = selection ? Math.min(selection.main.anchor, selection.main.head) : -1;
  const selTo = selection ? Math.max(selection.main.anchor, selection.main.head) : -1;

  function isNodeRevealed(range: SourceRange): boolean {
    if (!isFocused || !selection || selFrom === -1) return false;
    if (selFrom === selTo) {
      return selFrom > range.from && selTo < range.to;
    }
    return selFrom < range.to && selTo > range.from;
  }

  /**
   * 块级公式专用的揭示判据：在**两侧边界**上都比 `isNodeRevealed()` 放宽一格。
   *
   * `isNodeRevealed()` 要求光标**严格**落在范围内部，而 `range.from` 与 `range.to`
   * 恰好是首行行首和闭合 `$$` 那一行的行尾。点击闭合行 `$$` 右侧的空白区（或首行左侧）
   * 时 CM 会把光标贴到这两个位置上，严格判据不成立 → 块立刻折叠回渲染体。
   * 用户看到的就是"最后一行点不进去、一点就退出编辑态"。
   *
   * 放宽后这两个位置仍只属于块自己：上一行的行尾是 `range.from - 1`，
   * 下一行的行首是 `range.to + 1`，不会把相邻行卷进来。
   */
  function isBlockMathRevealed(range: SourceRange): boolean {
    if (!isFocused || !selection || selFrom === -1) return false;
    if (selFrom === selTo) {
      return selFrom >= range.from && selFrom <= range.to;
    }
    return selFrom <= range.to && selTo >= range.from;
  }

  /**
   * Mermaid 块当前该显示源码还是预览。
   *
   * 两种交互（header 按钮 / 点图）不是两条渲染路径，而是**同一个状态的两种输入**：
   * - 按钮写 `pin`（粘性：显式表态后一直有效）
   * - 点图不发 pin，只把光标送进块内（瞬时：光标一离开就回预览）
   * 渲染层只读这里派生出的结果，所以两者不竞争。
   *
   * 光标项是**必需**的、不是可选优化：被整块替换的块承载不了光标，所以只要光标在块内
   * 就必须处于源码态，否则编辑无从谈起。
   */
  function isMermaidSourceMode(from: number, range: SourceRange): boolean {
    const pin = mermaidPins.get(from);
    if (pin === 'source') return true;
    if (pin === 'preview') return false;
    return isNodeRevealed(range);
  }

  /**
   * 块级 widget 的替换范围末端：不包含结尾换行。
   *
   * 若把行尾换行也替换掉，widget 之后就不存在可承载光标的真实行——
   * 浏览器只能把 DOM 选区退回 cm-content，紧邻 widget 的输入会被静默丢弃
   * （表现为表格提交后立刻打字没有任何反应）。行尾换行留给源码行结构即可。
   */
  function blockWidgetDecorationEnd(range: SourceRange, raw: string): number {
    if (raw.endsWith('\r\n')) return Math.max(range.from, range.to - 2);
    if (raw.endsWith('\n')) return Math.max(range.from, range.to - 1);
    return range.to;
  }

  /**
   * 表格是否「还在书写中」：表格源码未以换行结束，且光标停在表格最后一行。
   *
   * 三个条件缺一不可：
   * - 只看文本会把文档加载后光标在别处的完整表格也降级成源码；
   * - 只看「光标在表格范围内」会误伤表格从 offset 0 开始的文档（光标停在 0 也算在范围内）；
   * - 只看光标位置会误伤点选表格（CodeMirror 会把光标贴到表格边界）。
   * 回车提交会补上结尾换行，条件不再成立，表格随即切回 widget 预览。
   */
  function isTableStillBeingWritten(range: SourceRange, raw: string): boolean {
    if (/\r?\n$/.test(raw)) return false;
    if (selFrom === -1) return false;
    const lastLineStart = source.lastIndexOf('\n', range.to - 1) + 1;
    return selFrom >= lastLineStart && selTo <= range.to + 1;
  }

  const opaqueBlockRanges: SourceRange[] = [];
  walkBlockNodes(root.children, (block) => {
    if (
      block.type === 'table' ||
      block.type === 'code-block' ||
      block.type === 'block-math' ||
      block.type === 'raw'
    ) {
      opaqueBlockRanges.push(block.range);
    }
  });

  for (const marker of findMarkdownMarkers(source)) {
    if (marker.type === 'inline-math' || marker.type === 'wikilink') continue;
    const insideOpaque = opaqueBlockRanges.some((b) => marker.from >= b.from && marker.to <= b.to);
    if (insideOpaque) continue;
    ranges.push({
      from: marker.from,
      to: marker.to,
      decoration: Decoration.mark({ class: `cm-visual-marker cm-visual-marker-${marker.type}` })
    });
  }

  function walkInline(inlineNode: MarkdownInlineNode): void {
    if (inlineNode.type === 'bold') {
      const delim = inlineNode.raw.startsWith('**') ? '**' : (inlineNode.raw.startsWith('__') ? '__' : '**');
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'italic') {
      const delim = inlineNode.raw.startsWith('*') ? '*' : (inlineNode.raw.startsWith('_') ? '_' : '*');
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delim.length,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delim.length,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'strike') {
      const raw =
        typeof inlineNode.raw === 'string' && inlineNode.raw.length > 0
          ? inlineNode.raw
          : source && inlineNode.range
            ? source.slice(inlineNode.range.from, inlineNode.range.to)
            : '';
      const delim = raw.startsWith('~') && !raw.startsWith('~~') ? '~' : '~~';
      const delimLen = delim.length;
      const isRevealed = isNodeRevealed(inlineNode.range);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.from + delimLen,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      ranges.push({
        from: inlineNode.range.to - delimLen,
        to: inlineNode.range.to,
        decoration: Decoration.replace({ widget: new DelimiterWidget(delim, isRevealed) })
      });
      if (inlineNode.range.to - delimLen > inlineNode.range.from + delimLen) {
        ranges.push({
          from: inlineNode.range.from + delimLen,
          to: inlineNode.range.to - delimLen,
          decoration: Decoration.mark({ class: 'cm-visual-strike' })
        });
      }
      for (const child of inlineNode.children) {
        walkInline(child);
      }
    } else if (inlineNode.type === 'link') {
      const isRevealed = isNodeRevealed(inlineNode.range);
      // 链接与 bold/italic/inline-code 同构：只替换 `[` 与 `](url)`，链接文字保留为
      // 真实文档文本。这样点击即落光标、直接输入即可改写，不需要 popover 与按钮。
      //
      // 安全契约不变：被拦截的协议依然不会产生任何可点击目标。差别只是承载方式由
      // `<a href>` 换成了 mark 装饰上的 `data-safe-href`——链接文字现在是可编辑文本，
      // 本来就不该是导航目标。
      const textEndIdx = findLinkTextEnd(inlineNode.raw);
      if (textEndIdx === -1) {
        // raw 结构不可解析：保守降级为整体替换，保持原样展示
        ranges.push({
          from: inlineNode.range.from,
          to: inlineNode.range.to,
          decoration: Decoration.replace({
            widget: new LinkWidget(
              inlineNode.range.from,
              inlineNode.range.to,
              inlineNode.raw,
              getInlineNodePlainText(inlineNode),
              inlineNode.safeHref,
              Boolean(inlineNode.isBlocked),
              inlineNode.title
            )
          })
        });
      } else {
        const openFrom = inlineNode.range.from;
        const textFrom = openFrom + 1;
        const closeFrom = openFrom + textEndIdx;
        const closeDelim = inlineNode.raw.slice(textEndIdx);

        ranges.push({
          from: openFrom,
          to: textFrom,
          decoration: Decoration.replace({ widget: new DelimiterWidget('[', isRevealed) })
        });
        if (closeFrom < inlineNode.range.to) {
          ranges.push({
            from: closeFrom,
            to: inlineNode.range.to,
            decoration: Decoration.replace({ widget: new DelimiterWidget(closeDelim, isRevealed) })
          });
        }

        if (closeFrom > textFrom) {
          const isBlocked = Boolean(inlineNode.isBlocked) || !inlineNode.safeHref;
          const attributes: Record<string, string> = {};
          if (isBlocked) {
            attributes['aria-disabled'] = 'true';
          } else {
            attributes['data-safe-href'] = inlineNode.safeHref as string;
          }
          if (inlineNode.title) {
            attributes.title = inlineNode.title;
          }
          ranges.push({
            from: textFrom,
            to: closeFrom,
            decoration: Decoration.mark({
              class: isBlocked ? 'cm-visual-link cm-visual-link-blocked' : 'cm-visual-link',
              attributes
            })
          });
        }

        for (const child of inlineNode.children) {
          walkInline(child);
        }
      }
    } else if (inlineNode.type === 'image') {
      const displaySrc = inlineNode.isBlocked
        ? null
        : resolveDocumentAssetUrl(inlineNode.src, documentDirectory);
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new ImageWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.alt,
            inlineNode.safeSrc,
            Boolean(inlineNode.isBlocked),
            inlineNode.title,
            displaySrc
          )
        })
      });
    } else if (inlineNode.type === 'inline-math') {
      // 与行内代码同构，但多一层：行内代码的正文**就是**渲染结果，而公式的正文是
      // LaTeX 源码，必须由 KaTeX 渲染。所以未揭示态只能是整节点替换；一旦光标落进
      // 范围内部，替换消失、`$...$` 变回真实文档文本，就地可改——不需要 popover。
      //
      // 整节点 widget 会把点击吞掉（CM 只能把光标贴到边界），而揭示判据要求光标
      // **严格落在内部**，所以激活手势由 InlineMathWidget 自己接管（activateMathSource）。
      const raw = inlineNode.raw;
      const openMatch = raw.match(/^\$+/);
      const delimiterLength = openMatch ? openMatch[0].length : 1;
      const delimiter = '$'.repeat(delimiterLength);
      const innerFrom = inlineNode.range.from + delimiterLength;
      const innerTo = inlineNode.range.to - delimiterLength;
      const isMalformed =
        raw.length < delimiterLength * 2 || !raw.endsWith(delimiter) || innerTo < innerFrom;

      if (!isMalformed && isNodeRevealed(inlineNode.range)) {
        ranges.push({
          from: inlineNode.range.from,
          to: innerFrom,
          decoration: Decoration.replace({ widget: new DelimiterWidget(delimiter, true) })
        });
        ranges.push({
          from: innerTo,
          to: inlineNode.range.to,
          decoration: Decoration.replace({ widget: new DelimiterWidget(delimiter, true) })
        });
        if (innerTo > innerFrom) {
          ranges.push({
            from: innerFrom,
            to: innerTo,
            decoration: Decoration.mark({ class: 'cm-visual-inline-math-source' })
          });
        }
      } else {
        ranges.push({
          from: inlineNode.range.from,
          to: inlineNode.range.to,
          decoration: Decoration.replace({
            widget: new InlineMathWidget(
              inlineNode.range.from,
              inlineNode.range.to,
              raw,
              inlineNode.formula
            )
          })
        });
      }
    } else if (inlineNode.type === 'inline-code') {
      // 行内代码与 bold/italic 同构：只把反引号围栏替换为 delimiter widget，
      // 正文保留为真实文档文本。这样光标可以原生落入、输入即编辑，不需要
      // popover、输入框和提交按钮。仅当围栏不配对（畸形 source）时才降级为
      // 整体替换，避免把不可解析的内容渲染成可编辑文本。
      const raw = inlineNode.raw;
      const openMatch = raw.match(/^`+/);
      const fenceLen = openMatch ? openMatch[0].length : 1;
      const fence = '`'.repeat(fenceLen);
      const innerFrom = inlineNode.range.from + fenceLen;
      const innerTo = inlineNode.range.to - fenceLen;

      if (raw.length < fenceLen * 2 || !raw.endsWith(fence) || innerTo < innerFrom) {
        ranges.push({
          from: inlineNode.range.from,
          to: inlineNode.range.to,
          decoration: Decoration.replace({
            widget: new InlineCodeWidget(
              inlineNode.range.from,
              inlineNode.range.to,
              inlineNode.raw,
              inlineNode.value
            )
          })
        });
      } else {
        const isRevealed = isNodeRevealed(inlineNode.range);
        ranges.push({
          from: inlineNode.range.from,
          to: innerFrom,
          decoration: Decoration.replace({ widget: new DelimiterWidget(fence, isRevealed) })
        });
        ranges.push({
          from: innerTo,
          to: inlineNode.range.to,
          decoration: Decoration.replace({ widget: new DelimiterWidget(fence, isRevealed) })
        });
        if (innerTo > innerFrom) {
          ranges.push({
            from: innerFrom,
            to: innerTo,
            decoration: Decoration.mark({ class: 'cm-visual-inline-code' })
          });
        }
      }
    } else if (inlineNode.type === 'wikilink') {
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new WikiLinkWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.target,
            inlineNode.alias
          )
        })
      });
    }
  }

  function walkBlock(blockNode: MarkdownBlockNode): void {
    if (blockNode.type === 'heading') {
      const match = blockNode.raw.match(/^([ \t]*)(#{1,6})/);
      if (match && match[2]) {
        const indentLen = (match[1] ?? '').length;
        const hashLen = match[2].length;
        const from = blockNode.range.from + indentLen;
        const isRevealed =
          isNodeRevealed(blockNode.range) ||
          isMarkerAtLineEnd(blockNode.raw, indentLen + hashLen);
        ranges.push({
          from,
          to: from + hashLen,
          decoration: Decoration.replace({ widget: new DelimiterWidget(match[2], isRevealed) })
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
      // 收集嵌套代码块所占用的文档行范围，避免 blockquote 抢先挂载 DelimiterWidget('>')
      // 导致与代码块自身装饰（header/exit widget、内容行前缀隐藏）冲突或折行
      const nestedCodeBlockRanges: { from: number; to: number }[] = [];
      for (const child of blockNode.children) {
        if (child.type === 'code-block') {
          const codeStart = source.lastIndexOf('\n', child.range.from - 1) + 1;
          const nextNl = source.indexOf('\n', child.range.to);
          const codeEnd = nextNl === -1 ? source.length : nextNl;
          nestedCodeBlockRanges.push({ from: codeStart, to: codeEnd });
        }
      }

      const bqLines = splitTableLines(blockNode.raw, blockNode.range.from);
      const bqLastIdx = bqLines.length - 1;
      for (let i = 0; i < bqLines.length; i++) {
        const bqLine = bqLines[i]!;
        const isInsideNestedCode = nestedCodeBlockRanges.some(
          (r) => bqLine.from >= r.from && bqLine.from <= r.to
        );

        if (!isInsideNestedCode) {
          const classes = ['cm-visual-blockquote-line'];
          if (i === 0) classes.push('cm-visual-blockquote-first-line');
          if (i === bqLastIdx) classes.push('cm-visual-blockquote-last-line');

          ranges.push({
            from: bqLine.from,
            to: bqLine.from,
            decoration: Decoration.line({
              class: classes.join(' ')
            })
          });

          // 匹配引用标记 `> ` 或 `>`
          const match = bqLine.text.match(/^([ \t]*)(>[ \t]?)/);
          if (match && match[2]) {
            const indentLen = match[1]?.length ?? 0;
            const markerLen = match[2].length;
            const from = bqLine.from + indentLen;
            const to = from + markerLen;
            const isRevealed =
              isNodeRevealed({ from: bqLine.from, to: bqLine.to }) ||
              isMarkerAtLineEnd(bqLine.text, indentLen + markerLen);
            ranges.push({
              from,
              to,
              decoration: Decoration.replace({
                widget: new DelimiterWidget(match[2], isRevealed)
              })
            });
          }
        }
      }
      for (const child of blockNode.children) {
        walkBlock(child);
      }
    } else if (blockNode.type === 'list') {
      for (const item of blockNode.items) {
        walkListItem(item);
      }
    } else if (blockNode.type === 'horizontal-rule') {
      ranges.push({
        from: blockNode.range.from,
        to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
        decoration: Decoration.replace({
          widget: new HorizontalRuleWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'table') {
      // 表格还在书写中（位于文档末尾且没有结尾换行）时保持原始文本：
      // 手写表格一旦被 block 级 widget 覆盖，后续按键就没有落点会被静默丢弃。
      // 回车提交会补上结尾换行，表格随即切换成 widget 预览。
      if (isTableStillBeingWritten(blockNode.range, blockNode.raw)) return;
      ranges.push({
        from: blockNode.range.from,
        // 替换范围不包含结尾换行：把它留给源码行结构，否则 widget 之后没有真实行，
        // 紧邻 widget 的光标拿不到 DOM 落点，提交后立即输入会丢失。
        to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
        decoration: Decoration.replace({
          widget: new TableBlockWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw,
            blockNode.headers,
            blockNode.rows,
            blockNode.align,
            locale
          ),
          block: true
        })
      });
    } else if (blockNode.type === 'code-block') {
      const lines = splitTableLines(blockNode.raw, blockNode.range.from);
      if (lines.length === 0) return;

      const firstLine = lines[0]!;
      const isQuoteNested = isInsideQuotePrefix(source, blockNode.range.from);
      // 引用块内嵌套时，首行在文档中的真实行起始位于 `>` 之前
      const firstLineDocStart = isQuoteNested
        ? source.lastIndexOf('\n', blockNode.range.from - 1) + 1
        : firstLine.from;

      // 缩进式代码块（4 空格缩进、无围栏）没有围栏行可替换，
      // 因此不挂 header/exit widget，但仍应作为代码块渲染：
      // 代码字体、行号，以及首末行的卡片边框。
      if (!hasFenceOpener(blockNode.raw, isQuoteNested)) {
        // 缩进式代码块按 CommonMark 在最后一个非空行结束，
        // 尾部空行不应占用行号（避免空行上渲染出一个孤立行号）。
        let contentLength = lines.length;
        while (contentLength > 1 && lines[contentLength - 1]!.text.trim() === '') {
          contentLength -= 1;
        }
        const plainLastIdx = contentLength - 1;
        for (let index = 0; index < contentLength; index++) {
          const line = lines[index]!;
          const lineDocStart = index === 0 && isQuoteNested ? firstLineDocStart : line.from;
          const classes = ['cm-visual-code-line', 'cm-visual-code-content-line'];
          if (isQuoteNested) {
            classes.unshift('cm-visual-blockquote-line', 'cm-visual-code-quote-nested');
          }
          if (index === 0) classes.push('cm-visual-code-plain-first-line');
          if (index === plainLastIdx) classes.push('cm-visual-code-plain-last-line');
          ranges.push({
            from: lineDocStart,
            to: lineDocStart,
            decoration: Decoration.line({
              class: classes.join(' '),
              attributes: {
                'data-code-line-number': String(index + 1)
              }
            })
          });
          if (isQuoteNested) {
            const prefixLen = leadingQuoteMarkerLength(line.text);
            if (prefixLen > 0) {
              ranges.push({
                from: line.from,
                to: line.from + prefixLen,
                decoration: Decoration.replace({
                  widget: new DelimiterWidget(line.text.slice(0, prefixLen), false)
                })
              });
            }
          }
        }
        return;
      }

      // 未闭合围栏保持原始文本可编辑，避免后续输入被 widget 吞掉
      if (!isClosedFence(blockNode.raw, isQuoteNested)) return;

      // Mermaid 块只在**未揭示**时整块替换成预览 widget。
      //
      // 光标进入块内时不能发这个替换：替换会把真实文档文本吞掉，源码就只剩 widget
      // 内部一个静态 <pre>，"Source 态"天生只读、根本没法编辑。揭示态直接走下面
      // 普通代码块的逐行装饰路径——源码行是真实文本，可编辑、有高亮，还自带
      // 代码块那套 header 与复制按钮。
      //
      // 判据用严格的 `isNodeRevealed`（不像块级公式那样放宽边界）：闭合围栏行末尾
      // 属于"已经离开代码块"，那里折叠回预览是符合预期的；而块级公式的闭合 `$$`
      // 是公式体的一部分，必须能点进去。
      // 判定走共享谓词：与「要不要加载 mermaid 扩展包」(`isMermaidMarker`) 和
      // 揭示态 header 上的切换按钮 (`code-block.ts`) 必须是同一份判断。
      // 三处各写一遍 `language === 'mermaid'` 时，` ```Mermaid ` 这种合法写法会让
      // 宿主白白下载 1.2MB 的包，却因为这里判不成立而什么都不渲染。
      const isMermaid = isMermaidLanguage(blockNode.language) && !isQuoteNested;
      if (isMermaid && !isMermaidSourceMode(blockNode.range.from, blockNode.range)) {
        ranges.push({
          from: blockNode.range.from,
          to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
          decoration: Decoration.replace({
            widget: new CodeBlockWidget(
              blockNode.range.from,
              blockNode.range.to,
              blockNode.raw,
              blockNode.language,
              blockNode.value,
              locale
            ),
            block: true
          })
        });
        return;
      }

      // 1. 首行：header 行样式挂在真实行首，header widget 替换整行首行文本（包含引用前缀）
      ranges.push({
        from: firstLineDocStart,
        to: firstLineDocStart,
        decoration: Decoration.line({
          class: isQuoteNested
            ? 'cm-visual-blockquote-line cm-visual-code-line cm-visual-code-quote-nested cm-visual-code-header-line'
            : 'cm-visual-code-line cm-visual-code-header-line',
          attributes: {
            'data-code-block-from': String(blockNode.range.from)
          }
        })
      });
      ranges.push({
        from: firstLineDocStart,
        to: firstLine.to,
        decoration: Decoration.replace({
          widget: new CodeBlockHeaderWidget(
            blockNode.range.from,
            firstLine.to,
            blockNode.language,
            blockNode.value,
            blockNode.range.to,
            locale
          )
        })
      });

      // 2. 中间代码行：挂载行号与 content-line 类名；若嵌套在引用块内，将行首引用前缀无损隐藏
      const lastLineIdx = lines.length - 1;
      let codeLineNum = 1;
      for (let i = 1; i < lastLineIdx; i++) {
        const line = lines[i]!;
        ranges.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            class: isQuoteNested
              ? 'cm-visual-blockquote-line cm-visual-code-line cm-visual-code-quote-nested cm-visual-code-content-line'
              : 'cm-visual-code-line cm-visual-code-content-line',
            attributes: {
              'data-code-line-number': String(codeLineNum++),
              'data-code-block-from': String(blockNode.range.from)
            }
          })
        });
        if (isQuoteNested) {
          const prefixLen = leadingQuoteMarkerLength(line.text);
          if (prefixLen > 0) {
            ranges.push({
              from: line.from,
              to: line.from + prefixLen,
              decoration: Decoration.replace({
                widget: new DelimiterWidget(line.text.slice(0, prefixLen), false)
              })
            });
          }
        }
      }

      // 3. 末行：closing 行样式 + exit widget 替换整行围栏文本
      if (lastLineIdx > 0) {
        const lastLine = lines[lastLineIdx]!;
        ranges.push({
          from: lastLine.from,
          to: lastLine.from,
          decoration: Decoration.line({
            class: isQuoteNested
              ? 'cm-visual-blockquote-line cm-visual-code-line cm-visual-code-quote-nested cm-visual-code-closing-line'
              : 'cm-visual-code-line cm-visual-code-closing-line',
            attributes: {
              'data-code-block-from': String(blockNode.range.from)
            }
          })
        });
        ranges.push({
          from: lastLine.from,
          to: lastLine.to,
          decoration: Decoration.replace({
            widget: new CodeBlockExitWidget(blockNode.range.to)
          })
        });
      }
    } else if (blockNode.type === 'block-math') {
      if (isBlockMathRevealed(blockNode.range)) {
        // 揭示态：**不加替换装饰**——`$$ ... $$` 的源码行原样保留为真实文本，
        // 光标可以正常落入、直接改；同时在块尾追加一个实时预览 widget，
        // 于是"源码 + 渲染结果"并存，边打边看。
        //
        // 这里刻意不用 textarea 子编辑器：那样编辑期间预览会整个消失，
        // 而且要额外维护一套提交/校验/关闭逻辑。直接改源码就没有这些状态。
        //
        // 预览 widget 要落在**行边界**上。`range.to` 是闭合 `$$` 那一行的行尾
        // （`raw` 不含行尾换行），推到下一行行首，预览才会出现在块的下方。
        const previewPos = blockNode.range.to + (source[blockNode.range.to] === '\r' ? 1 : 0) +
          (source[blockNode.range.to + (source[blockNode.range.to] === '\r' ? 1 : 0)] === '\n' ? 1 : 0);
        ranges.push({
          from: previewPos,
          to: previewPos,
          decoration: Decoration.widget({
            block: true,
            side: 1,
            widget: new BlockMathPreviewWidget(
              blockNode.range.from,
              blockNode.range.to,
              blockNode.raw,
              blockNode.formula
            )
          })
        });
      } else {
        ranges.push({
          from: blockNode.range.from,
          to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
          decoration: Decoration.replace({
            widget: new BlockMathWidget(
              blockNode.range.from,
              blockNode.range.to,
              blockNode.raw,
              blockNode.formula
            ),
            block: true
          })
        });
      }
    } else if (blockNode.type === 'raw') {
      ranges.push({
        from: blockNode.range.from,
        to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
        decoration: Decoration.replace({
          widget: new RawBlockWidget(
            blockNode.range.from,
            blockNode.range.to,
            blockNode.raw
          ),
          block: true
        })
      });
    }
  }

  /**
   * 未进入编辑态时给列表标记画替身，进入后交回 DelimiterWidget 显示真实 marker。
   *
   * 两者必须成对出现：只隐藏不画，整行就会既没有圆点也没有编号（有序列表尤其明显）。
   */
  function pushListMarker(
    marker: string,
    markerFrom: number,
    markerTo: number,
    lineEndOffset: number,
    line: string,
    revealed: boolean
  ): void {
    // 列表标记独占行时保持可见，否则后续输入会落到文档开头
    const itemRevealed = revealed || isMarkerAtLineEnd(line, lineEndOffset);
    ranges.push({
      from: markerFrom,
      to: markerTo,
      decoration: Decoration.replace({
        widget: itemRevealed
          ? new DelimiterWidget(marker, true)
          : new ListMarkerWidget(marker, /^\d/.test(marker))
      })
    });
  }

  function walkListItem(item: MarkdownListItem): void {
    const isRevealed = isNodeRevealed(item.range);
    const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
    if (item.task) {
      const match = firstLine.match(/^([ \t]*>(?:[ \t]*>)*)?([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(\[[ xX]\])/);
      if (match && match[3]) {
        const quoteLen = (match[1] ?? '').length;
        const prefixLen = quoteLen + (match[2] ?? '').length;

        // 任务项此前把 `- ` 留在正文里，会和普通列表项的 `•` 并列出现，观感不一致。
        // 这里同样用替身替换掉 marker，只保留复选框 widget。
        const markerMatch = (match[2] ?? '').match(/^([ \t]*)([-+*]|\d+[.)])/);
        if (markerMatch && markerMatch[2]) {
          const markerIndentLen = markerMatch[1]?.length ?? 0;
          const markerFrom = item.range.from + quoteLen + markerIndentLen;
          pushListMarker(
            markerMatch[2],
            markerFrom,
            markerFrom + markerMatch[2].length,
            quoteLen + markerIndentLen + markerMatch[2].length,
            firstLine,
            isRevealed
          );
        }

        const from = item.range.from + prefixLen;
        const to = from + match[3].length;
        const isChecked = Boolean(item.checked);
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({ widget: new TaskCheckboxWidget(isChecked, from, to) })
        });
      }
    } else {
      const match = firstLine.match(/^([ \t]*)([-+*]|\d+[.)])/);
      if (match && match[2]) {
        const indentLen = match[1]?.length ?? 0;
        const markerFrom = item.range.from + indentLen;
        pushListMarker(
          match[2],
          markerFrom,
          markerFrom + match[2].length,
          indentLen + match[2].length,
          firstLine,
          isRevealed
        );
      }
    }

    const blockTypes = new Set([
      'heading',
      'paragraph',
      'blockquote',
      'list',
      'code-block',
      'block-math',
      'table',
      'raw',
      'horizontal-rule'
    ]);
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

  // RangeSetBuilder 只接受按 (from, value.startSide) 升序的输入——这是
  // @codemirror/state 里 cmpRange 的硬契约，不是可选的偏好。
  // 只按 from/to 排序不够：同一 from 上 mark 的 startSide 是 500000000，
  // 而 replace 是 499999999，所以 mark 必须排在 replace **之后**。
  // 反例：`[![alt](img)](url)`——链接文字本身就是一个图片 widget，链接 mark 与图片
  // replace 的 from/to 完全相同，先推 mark 会让 builder 抛
  // "Ranges must be added sorted by `from` position and `startSide`"；
  // EditorState 构造失败后 React 没有错误边界，整棵树被卸载，表现为整窗白屏。
  ranges.sort(
    (left, right) =>
      left.from - right.from || left.decoration.startSide - right.decoration.startSide
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (range.from <= range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }
  return builder.finish();
}

