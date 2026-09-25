import {
  StateField,
  RangeSetBuilder,
  StateEffect,
  EditorSelection,
  Compartment,
  Facet,
  type Extension
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
import {
  parseMarkdown,
  getRowCellRanges,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
  type SourceRange
} from '@nexus/markdown';
import { findMarkdownMarkers } from './markdown-markers.js';
import { extensionHostFacet, mountExtension } from './extensions.js';
import type { EditorExtensionControl } from './extensions.js';
import {
  LinkWidget,
  ImageWidget,
  InlineMathWidget,
  InlineCodeWidget,
  WikiLinkWidget,
  activateMathSource,
  getInlineNodePlainText
} from './inline-edit.js';
import { isEditorComposing, setComposingEffect } from './ime-composition.js';
import {
  findTableAtPosition,
  createTableAddRowTransaction,
  createTableAddColumnTransaction,
  createTableDeleteRowTransaction,
  createTableDeleteColumnTransaction,
  createTableSetAlignTransaction,
  createTableCellEditTransaction,
  createTableDeleteTransaction,
  createTableResizeTransaction,
  splitTableLines,
  type TableCellContext
} from './table-edit.js';
import {
  dispatchCodeBlockLanguageChange
} from './code-block-edit.js';
import { walkBlockNodes } from './ast-walker.js';
import {
  DEFAULT_CODE_LANGUAGES,
  normalizeLanguage
} from './code-highlight.js';
import { translate } from '@nexus/i18n';
import { editorLocaleFacet } from './source-editor.js';

/** 注册到单个 EditorView 的可关闭子编辑器。 */
interface ActiveSubEditor {
  close: () => void;
}

const activeSubEditors = new WeakMap<EditorView, Set<ActiveSubEditor>>();

function registerActiveSubEditor(view: EditorView, editor: ActiveSubEditor): () => void {
  let set = activeSubEditors.get(view);
  if (!set) {
    set = new Set();
    activeSubEditors.set(view, set);
  }
  set.add(editor);
  return () => {
    set?.delete(editor);
  };
}

/** 子编辑器的监听信号与幂等关闭入口。 */
interface SubEditorController {
  signal: AbortSignal;
  isActive: () => boolean;
  close: () => void;
}

/** 统一管理子编辑器事件、注册和幂等关闭。 */
function createSubEditorController(
  view: EditorView,
  onClose: () => void
): SubEditorController {
  const abortController = new AbortController();
  let active = true;
  let unregister = () => {};

  const close = () => {
    if (!active) return;
    active = false;
    abortController.abort();
    unregister();
    onClose();
  };

  unregister = registerActiveSubEditor(view, { close });
  return {
    signal: abortController.signal,
    isActive: () => active,
    close
  };
}

function closeAllActiveSubEditors(view: EditorView): void {
  const set = activeSubEditors.get(view);
  if (set) {
    for (const editor of Array.from(set)) {
      editor.close();
    }
    set.clear();
  }
}

class SubEditorLifecyclePlugin {
  public disposed = false;
  public generation = 0;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (update.startState.readOnly !== update.state.readOnly) {
      const isRo = update.state.readOnly;
      // 工具栏由 tableWidgetSyncPlugin 依据只读状态和有效目标统一刷新。
      if (isRo) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }

    if (update.docChanged) {
      const isInternalSubEditorCommit = update.transactions.some(
        (tr) =>
          tr.isUserEvent('table.cell-edit') ||
          tr.isUserEvent('code-block.value-edit') ||
          tr.isUserEvent('code-block.language-edit') ||
          tr.isUserEvent(RAW_BLOCK_EDIT_USER_EVENT)
      );
      if (!isInternalSubEditorCommit) {
        this.generation++;
        closeAllActiveSubEditors(update.view);
      }
    }
  }

  destroy() {
    this.disposed = true;
    this.generation++;
    closeAllActiveSubEditors(this.view);
  }
}

const subEditorLifecyclePlugin = ViewPlugin.fromClass(SubEditorLifecyclePlugin);

const RAW_BLOCK_EDIT_USER_EVENT = 'raw-block.edit';

export const setVisualFocusEffect = StateEffect.define<boolean>();

export const visualFocusField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVisualFocusEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export const visualFocusPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener('focus', this.onFocus, true);
      view.dom.addEventListener('blur', this.onBlur, true);
      view.dom.addEventListener('focusin', this.onFocus);
      view.dom.addEventListener('focusout', this.onBlur);
      const origFocus = view.focus.bind(view);
      view.focus = () => {
        origFocus();
        if (!view.state.field(visualFocusField, false)) {
          view.dispatch({ effects: setVisualFocusEffect.of(true) });
        }
      };
    }
    onFocus = () => {
      if (!this.view.state.field(visualFocusField, false)) {
        this.view.dispatch({ effects: setVisualFocusEffect.of(true) });
      }
    };
    onBlur = (event: FocusEvent) => {
      if (event.relatedTarget && this.view.dom.contains(event.relatedTarget as Node)) {
        return;
      }
      if (!this.view.dom.isConnected) return;
      if (this.view.dom.contains(document.activeElement)) return;
      if (this.view.state.field(visualFocusField, false)) {
        try {
          this.view.dispatch({ effects: setVisualFocusEffect.of(false) });
        } catch {
          queueMicrotask(() => {
            if (
              this.view.dom.isConnected &&
              !this.view.dom.contains(document.activeElement) &&
              this.view.state.field(visualFocusField, false)
            ) {
              this.view.dispatch({ effects: setVisualFocusEffect.of(false) });
            }
          });
        }
      }
    };
    destroy() {
      this.view.dom.removeEventListener('focus', this.onFocus, true);
      this.view.dom.removeEventListener('blur', this.onBlur, true);
      this.view.dom.removeEventListener('focusin', this.onFocus);
      this.view.dom.removeEventListener('focusout', this.onBlur);
    }
  }
);

export const setDocumentDirectoryEffect = StateEffect.define<string | null>();

export const documentDirectoryField = StateField.define<string | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDocumentDirectoryEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export function setDocumentDirectory(view: EditorView, directory: string | null): void {
  view.dispatch({ effects: setDocumentDirectoryEffect.of(directory) });
}

export interface TableTarget {
  tableFrom: number;
  activeRow: number | null; // null: unselected; -1: header; 0..n: data row
  activeCol: number | null; // null: unselected; 0..m: column
}

export const setTableTargetEffect = StateEffect.define<TableTarget | null>();

export const tableTargetField = StateField.define<TableTarget | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTableTargetEffect)) {
        return effect.value;
      }
    }
    if (!value) return null;
    if (tr.docChanged) {
      const oldSource = tr.startState.doc.toString();
      const oldTable = findTableAtPosition(oldSource, value.tableFrom);
      if (!oldTable) {
        return null;
      }

      // 起点前插入内容时跟随原表格；整块替换后不凭相同文字继承身份。
      const newFrom = tr.changes.mapPos(value.tableFrom, 1);
      const newSource = tr.newDoc.toString();
      const newTable = findTableAtPosition(newSource, newFrom);
      if (!newTable || newTable.tableRange.from !== newFrom) {
        return null;
      }

      let activeRow: number | null = null;
      let activeCol: number | null = null;

      // 只通过仍然存活的表头槽位映射列，删除的槽位不能转移到同名列。
      if (
        value.activeCol !== null &&
        value.activeCol >= 0 &&
        value.activeCol < oldTable.headers.length
      ) {
        const oldLines = splitTableLines(oldTable.raw, oldTable.tableRange.from);
        if (oldLines.length >= 1) {
          const oldHeaderLine = oldLines[0]!;
          const oldPrefixMatch = oldHeaderLine.text.match(/^([ \t]*(?:>[ \t]*)*)/);
          const oldPrefixLen = oldPrefixMatch ? oldPrefixMatch[0]!.length : 0;
          const oldCleanText = oldHeaderLine.text.slice(oldPrefixLen);
          const oldCellRanges = getRowCellRanges(oldCleanText, oldHeaderLine.from + oldPrefixLen);

          if (value.activeCol < oldCellRanges.length) {
            const oldCell = oldCellRanges[value.activeCol]!;
            const oldSlotFrom = oldHeaderLine.from + oldPrefixLen + oldCell.slotStart;
            const oldSlotTo = oldHeaderLine.from + oldPrefixLen + oldCell.slotEnd;
            const mappedSlotFrom = tr.changes.mapPos(oldSlotFrom, 1);
            const mappedSlotTo = tr.changes.mapPos(oldSlotTo, -1);

            if (mappedSlotFrom < mappedSlotTo) {
              const newLines = splitTableLines(newTable.raw, newTable.tableRange.from);
              if (newLines.length >= 1) {
                const newHeaderLine = newLines[0]!;
                const newPrefixMatch = newHeaderLine.text.match(/^([ \t]*(?:>[ \t]*)*)/);
                const newPrefixLen = newPrefixMatch ? newPrefixMatch[0]!.length : 0;
                const newCleanText = newHeaderLine.text.slice(newPrefixLen);
                const newCellRanges = getRowCellRanges(newCleanText, newHeaderLine.from + newPrefixLen);

                for (let c = 0; c < newCellRanges.length; c++) {
                  const nCell = newCellRanges[c]!;
                  const nSlotFrom = newHeaderLine.from + newPrefixLen + nCell.slotStart;
                  const nSlotTo = newHeaderLine.from + newPrefixLen + nCell.slotEnd;
                  if (mappedSlotFrom >= nSlotFrom && mappedSlotTo <= nSlotTo) {
                    activeCol = c;
                    break;
                  } else if (mappedSlotFrom >= nSlotFrom && mappedSlotFrom < nSlotTo) {
                    activeCol = c;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // 行身份来自原始行范围；重复行正文不能作为身份依据。
      if (value.activeRow !== null) {
        if (value.activeRow === -1) {
          activeRow = -1;
        } else if (value.activeRow >= 0 && value.activeRow < oldTable.rows.length) {
          const oldLines = splitTableLines(oldTable.raw, oldTable.tableRange.from);
          const oldTargetLineIdx = 2 + value.activeRow;
          if (oldTargetLineIdx < oldLines.length) {
            const oldRowLine = oldLines[oldTargetLineIdx]!;
            const mappedLineFrom = tr.changes.mapPos(oldRowLine.from, 1);
            const mappedLineTo = tr.changes.mapPos(oldRowLine.to, -1);

            if (mappedLineFrom < mappedLineTo) {
              const newLines = splitTableLines(newTable.raw, newTable.tableRange.from);
              for (let r = 0; r < newTable.rows.length; r++) {
                const newLineIdx = 2 + r;
                if (newLineIdx < newLines.length) {
                  const newRowLine = newLines[newLineIdx]!;
                  if (
                    mappedLineFrom >= newRowLine.from &&
                    mappedLineTo <= newRowLine.to + newRowLine.newline.length
                  ) {
                    activeRow = r;
                    break;
                  } else if (mappedLineFrom >= newRowLine.from && mappedLineFrom < newRowLine.to) {
                    activeRow = r;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      if (activeCol === null && activeRow === null) {
        return null;
      }

      return {
        tableFrom: newTable.tableRange.from,
        activeRow,
        activeCol
      };
    }
    return value;
  }
});

export function resolveDocumentAssetUrl(
  src: string,
  documentDirectory: string | null | undefined
): string | null {
  if (!src || typeof src !== 'string') return null;
  let trimmed = src.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  if (!documentDirectory) {
    return null;
  }

  try {
    const hashIndex = trimmed.indexOf('#');
    const queryIndex = trimmed.indexOf('?');
    let pathPart = trimmed;
    let suffix = '';

    const firstSep =
      hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);
    if (firstSep !== -1) {
      pathPart = trimmed.slice(0, firstSep);
      suffix = trimmed.slice(firstSep);
    }

    try {
      pathPart = decodeURI(pathPart);
    } catch {
      // ignore malformed URI
    }

    const normBase = documentDirectory.replace(/\\/g, '/');
    const normRel = pathPart.replace(/\\/g, '/');

    const isWindowsAbsolute = /^[a-zA-Z]:/.test(normBase);
    const isPosixAbsolute = normBase.startsWith('/');

    if (!isWindowsAbsolute && !isPosixAbsolute) {
      return null;
    }

    const baseSegments = normBase.split('/').filter(Boolean);
    const relSegments = normRel.split('/').filter(Boolean);

    let resolvedSegments: string[];
    if (normRel.startsWith('/')) {
      if (isWindowsAbsolute) {
        resolvedSegments = [baseSegments[0]!, ...relSegments];
      } else {
        resolvedSegments = [...relSegments];
      }
    } else {
      resolvedSegments = [...baseSegments];
      for (const seg of relSegments) {
        if (seg === '.') {
          continue;
        } else if (seg === '..') {
          if (isWindowsAbsolute && resolvedSegments.length <= 1) {
            continue;
          }
          if (resolvedSegments.length > 0) {
            resolvedSegments.pop();
          }
        } else {
          resolvedSegments.push(seg);
        }
      }
    }

    if (isWindowsAbsolute) {
      const drive = resolvedSegments[0]!;
      const rest = resolvedSegments.slice(1).map(encodeURIComponent).join('/');
      return `file:///${drive}/${rest}${suffix}`;
    } else {
      const rest = resolvedSegments.map(encodeURIComponent).join('/');
      return `file:///${rest}${suffix}`;
    }
  } catch {
    return null;
  }
}

export class DelimiterWidget extends WidgetType {
  public constructor(
    public readonly delimiter: string,
    public readonly revealed: boolean = false
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.revealed ? 'cm-visual-delimiter-revealed' : 'cm-visual-hidden-delimiter';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.delimiter = this.delimiter;
    if (this.revealed) {
      element.textContent = this.delimiter;
    }
    return element;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof DelimiterWidget &&
      other.delimiter === this.delimiter &&
      other.revealed === this.revealed
    );
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

export { DelimiterWidget as HiddenDelimiterWidget };

/**
 * 标记之后是否已经没有内容（含只有空白的情况）。
 *
 * 隐藏标记用的是 replace 型 widget：一旦标记独占该行，行内就不存在可放置 DOM 光标的
 * 文本节点，浏览器会把下一个输入字符落到文档开头，表现为首字符被挤到末尾
 * （例如输入 `- i` 得到 ` i-`、输入 `# h` 得到 ` h#`）。
 * 因此标记独占行时必须保持可见。
 */
function isMarkerAtLineEnd(lineText: string, markerEnd: number): boolean {
  return lineText.slice(markerEnd).trim().length === 0;
}

/**
 * 链接文字在 raw 中的结束位置（返回 `]` 的下标），找不到返回 -1。
 *
 * 不能用 `raw.indexOf(']')`：链接文字里可以嵌套方括号，例如图片链接
 * `[![alt](img)](url)` 的第一个 `]` 属于内层图片，用 indexOf 会把链接文字截成
 * `![alt`、把 `](img)](url)` 整段当成闭合分隔符隐藏掉。这里按嵌套深度配对。
 */
function findLinkTextEnd(raw: string): number {
  let depth = 0;
  for (let index = 1; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

/**
 * 引用块标记前缀长度：`>` 每层最多吞掉其后的一个空格/制表符，
 * 其余空格属于代码自身缩进，必须保留（`>     indented` 里 4 个空格是代码内容）。
 */
function leadingQuoteMarkerLength(lineText: string): number {
  const match = lineText.match(/^[ \t]*(?:>[ \t]?)+/);
  return match ? match[0].length : 0;
}

/** 去掉引用标记后的行文本。 */
function stripQuoteMarkers(lineText: string): string {
  return lineText.slice(leadingQuoteMarkerLength(lineText));
}

/**
 * `from` 之前的同一行内容是否只有引用标记。
 *
 * 引用块内的代码块 raw 只有首行不带 `>`、其余行带（`"```ts\n> code\n> ```"`），
 * 所以判断「是否位于引用块内」不能只看节点自身文本，必须回看文档前缀。
 */
function isInsideQuotePrefix(source: string, from: number): boolean {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  return /^[ \t]*(?:>[ \t]*)+$/.test(source.slice(lineStart, from));
}

/**
 * raw 首行是否带围栏起始。
 *
 * 用于区分「围栏代码块」与「缩进式代码块」：后者没有围栏行，
 * 不能挂 header/exit widget，但仍应作为代码块渲染出行号与代码样式。
 */
function hasFenceOpener(raw: string, isQuoteNested: boolean): boolean {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const text = isQuoteNested ? stripQuoteMarkers(firstLine) : firstLine;
  return /^(`{3,}|~{3,})/.test(text.trim());
}

/**
 * 围栏是否闭合，且兼容引用块内的代码块。
 *
 * `isFenceClosed` 直接检查 raw 首行是否以围栏开头，而引用块内的代码块
 * raw 形如 "```ts\n> code\n> ```"（首行没有 `>`、其余行带），因此会被判为
 * 未闭合而整块退化成原文，既没有行号也没有语法高亮。
 * 这里在引用块场景下逐行剥离引用标记后再判定，
 * 同时保持「未闭合围栏保留原文」的既有语义。
 */
function isClosedFence(raw: string, isQuoteNested: boolean): boolean {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;

  const normalizeLine = (line: string) =>
    (isQuoteNested ? stripQuoteMarkers(line) : line).trim();
  const opener = normalizeLine(lines[0]!).match(/^(`{3,}|~{3,})/);
  if (!opener) return false;

  const fenceChar = opener[1]![0]!;
  const minLength = opener[1]!.length;
  return new RegExp(`^\\${fenceChar}{${minLength},}$`).test(
    normalizeLine(lines[lines.length - 1]!)
  );
}


export class HorizontalRuleWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return 33;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof HorizontalRuleWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-hr-container';
    container.tabIndex = 0;
    container.setAttribute('role', 'separator');

    const hr = document.createElement('hr');
    hr.className = 'cm-visual-horizontal-rule';
    container.appendChild(hr);

    const startEdit = () => {
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-hr-editor')) return;

      const raw = this.raw;
      // 标记内部空格可编辑；外围缩进、行尾空白和换行属于原始布局，单独保留。
      const match = raw.match(/^([ \t]*(?:>[ \t]*)*)([^\r\n]*?)([ \t]*(?:\r?\n)*)$/);
      const prefix = match ? match[1]! : '';
      const marker = match ? match[2]! : raw.trim();
      const suffix = match ? match[3]! : '';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-hr-editor';
      input.value = marker;

      hr.style.display = 'none';
      container.appendChild(input);
      input.focus();
      input.select();

      const controller = createSubEditorController(view, () => {
        input.remove();
        hr.style.display = '';
        container.focus();
      });
      const { signal } = controller;

      let isComposing = false;
      input.addEventListener('compositionstart', () => { isComposing = true; }, { signal });
      input.addEventListener('compositionend', () => { isComposing = false; }, { signal });

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newValue = input.value;
        if (newValue === marker) {
          controller.close();
          return;
        }
        const source = view.state.doc.toString();
        const parsed = parseMarkdown(source);
        let targetRange: { from: number; to: number } | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'horizontal-rule' && child.range.from === this.from) {
            targetRange = { from: child.range.from, to: child.range.to };
            return true;
          }
          return false;
        });
        const finalRange = targetRange as { from: number; to: number } | null;
        if (finalRange) {
          const newRaw = prefix + newValue + suffix;
          view.dispatch({
            changes: { from: finalRange.from, to: finalRange.to, insert: newRaw },
            userEvent: 'horizontal-rule.edit'
          });
        }
        controller.close();
      };

      input.addEventListener(
        'keydown',
        (e) => {
          if (!controller.isActive() || isComposing || e.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      input.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) {
            commit();
          }
        },
        { signal }
      );
    };

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit();
    });

    container.addEventListener('keydown', (e) => {
      if (e.target !== container) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        startEdit();
      }
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
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
 * 列表标记的视觉替身。
 *
 * 无序列表的 `-`/`*`/`+` 与有序列表的 `1.` 都是 source 语法标记，未进入编辑态时
 * 被 `DelimiterWidget` 隐藏（`.cm-visual-hidden-delimiter { display: none }`）。
 * 但列表标记同时也是读者可见的结构信息，隐藏后必须画出替身，否则整行既没有
 * 圆点也没有编号：
 *
 * - 无序列表画 `•`；
 * - 有序列表画 source 里的编号本身。刻意不做自动重编号：本编辑器的第一原则是
 *   「所见即文件内容」，显示的编号必须能在 source 里找到对应。
 *
 * 光标进入该列表项后改由 `DelimiterWidget` 显示真实 marker，可直接编辑。
 */
export class ListMarkerWidget extends WidgetType {
  public constructor(
    public readonly marker: string,
    public readonly ordered: boolean
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.ordered
      ? 'cm-visual-list-marker cm-visual-list-marker-ordered'
      : 'cm-visual-list-marker';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.marker = this.marker;
    element.textContent = this.ordered ? this.marker : '•';
    return element;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof ListMarkerWidget &&
      other.marker === this.marker &&
      other.ordered === this.ordered
    );
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

const TABLE_ALIGN_LEFT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="15" y1="12" x2="3" y2="12"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_ALIGN_CENTER_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="19" y1="12" x2="5" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_ALIGN_RIGHT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="12" x2="9" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_GRID_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`;
const TABLE_TRASH_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

export function renderTableCellNodes(nodes: MarkdownInlineNode[], parentEl: HTMLElement): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        parentEl.appendChild(document.createTextNode(node.value));
        break;
      }
      case 'bold': {
        const strong = document.createElement('strong');
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '**';
        leftDelim.textContent = '**';
        strong.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, strong);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '**';
        rightDelim.textContent = '**';
        strong.appendChild(rightDelim);

        parentEl.appendChild(strong);
        break;
      }
      case 'italic': {
        const em = document.createElement('em');
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '*';
        leftDelim.textContent = '*';
        em.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, em);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '*';
        rightDelim.textContent = '*';
        em.appendChild(rightDelim);

        parentEl.appendChild(em);
        break;
      }
      case 'strike': {
        const del = document.createElement('del');
        del.className = 'cm-visual-strike';
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '~~';
        leftDelim.textContent = '~~';
        del.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, del);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '~~';
        rightDelim.textContent = '~~';
        del.appendChild(rightDelim);

        parentEl.appendChild(del);
        break;
      }
      case 'inline-code': {
        const code = document.createElement('code');
        code.className = 'cm-visual-inline-code';
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '`';
        leftDelim.textContent = '`';
        code.appendChild(leftDelim);

        code.appendChild(document.createTextNode(node.value));

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '`';
        rightDelim.textContent = '`';
        code.appendChild(rightDelim);

        parentEl.appendChild(code);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.className = 'cm-visual-link';
        // Keep the original href/title for lossless serialization, but only ever
        // expose a sanitized href to the DOM. Mirrors the LinkWidget policy in
        // inline-edit.ts: blocked protocols must never become live anchors.
        a.dataset.rawHref = node.href ?? '';
        if (node.title) a.dataset.rawTitle = node.title;
        if (node.isBlocked || !node.safeHref) {
          a.classList.add('cm-visual-link-blocked');
          a.setAttribute('aria-disabled', 'true');
        } else {
          a.setAttribute('href', node.safeHref);
          if (node.title) a.setAttribute('title', node.title);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }

        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '[';
        leftDelim.textContent = '[';
        a.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, a);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = `](${node.href || ''})`;
        rightDelim.textContent = `](${node.href || ''})`;
        a.appendChild(rightDelim);

        parentEl.appendChild(a);
        break;
      }
      case 'inline-math': {
        const mathSpan = document.createElement('span');
        mathSpan.className = 'cm-table-inline-math';
        mathSpan.dataset.formula = node.formula;
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '$';
        leftDelim.textContent = '$';
        mathSpan.appendChild(leftDelim);

        const formulaText = document.createElement('span');
        formulaText.className = 'cm-table-math-render';
        formulaText.textContent = node.formula;
        mathSpan.appendChild(formulaText);

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '$';
        rightDelim.textContent = '$';
        mathSpan.appendChild(rightDelim);

        parentEl.appendChild(mathSpan);
        break;
      }
      case 'wikilink': {
        const wikiSpan = document.createElement('span');
        wikiSpan.className = 'cm-visual-wikilink';
        // Preserve target/alias so serialization can rebuild [[target|alias]].
        wikiSpan.dataset.wikiTarget = node.target;
        if (node.alias) wikiSpan.dataset.wikiAlias = node.alias;
        wikiSpan.textContent = node.alias || node.target;
        parentEl.appendChild(wikiSpan);
        break;
      }
      case 'raw': {
        if (/<br\s*\/?>/i.test(node.value)) {
          parentEl.appendChild(document.createElement('br'));
        } else {
          parentEl.appendChild(document.createTextNode(node.value));
        }
        break;
      }
      default: {
        if ('value' in node && typeof (node as any).value === 'string') {
          parentEl.appendChild(document.createTextNode((node as any).value));
        } else if ('raw' in node && typeof (node as any).raw === 'string') {
          parentEl.appendChild(document.createTextNode((node as any).raw));
        }
        break;
      }
    }
  }
}

export function serializeTableCellDOM(el: HTMLElement): string {
  let result = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const elem = child as HTMLElement;
      if (
        elem.classList.contains('cm-visual-hidden-delimiter') ||
        elem.classList.contains('cm-visual-delimiter-revealed') ||
        elem.getAttribute('aria-hidden') === 'true'
      ) {
        continue;
      }
      if (elem.classList.contains('cm-table-cell-placeholder')) {
        continue;
      }
      const tag = elem.tagName.toLowerCase();
      if (tag === 'br') {
        result += '<br>';
      } else if (tag === 'strong' || tag === 'b') {
        result += `**${serializeTableCellDOM(elem)}**`;
      } else if (tag === 'em' || tag === 'i') {
        result += `*${serializeTableCellDOM(elem)}*`;
      } else if (tag === 'del' || tag === 's' || elem.classList.contains('cm-visual-strike')) {
        result += `~~${serializeTableCellDOM(elem)}~~`;
      } else if (tag === 'code' || elem.classList.contains('cm-visual-inline-code')) {
        result += `\`${serializeTableCellDOM(elem)}\``;
      } else if (tag === 'a' || elem.classList.contains('cm-visual-link')) {
        const href = elem.dataset.rawHref ?? elem.getAttribute('href') ?? '';
        const title = elem.dataset.rawTitle;
        result += `[${serializeTableCellDOM(elem)}](${href}${title ? ` "${title}"` : ''})`;
      } else if (elem.classList.contains('cm-table-inline-math') || elem.dataset.formula) {
        const formula = elem.dataset.formula ?? elem.textContent ?? '';
        result += `$${formula}$`;
      } else if (elem.classList.contains('cm-visual-wikilink')) {
        const target = elem.dataset.wikiTarget ?? '';
        const alias = elem.dataset.wikiAlias;
        result += alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
      } else {
        result += serializeTableCellDOM(elem);
      }
    }
  }
  return result;
}

export function populateTableCellDOM(cellEl: HTMLElement, cellNodes: MarkdownInlineNode[]): void {
  cellEl.textContent = '';
  const contentWrap = document.createElement('div');
  contentWrap.className = 'cm-table-cell-content';
  const cellRaw = cellNodes
    .map((n) => ('value' in n && typeof (n as any).value === 'string' ? (n as any).value : n.raw))
    .join('');
  if (!cellRaw.trim() && !cellNodes.some((n) => n.type === 'raw' && /<br\s*\/?>/i.test(n.value))) {
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-table-cell-placeholder';
    const br = document.createElement('br');
    placeholder.appendChild(br);
    contentWrap.appendChild(placeholder);
  } else {
    renderTableCellNodes(cellNodes, contentWrap);
  }
  cellEl.appendChild(contentWrap);
}

export class TableBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly headers: MarkdownInlineNode[][],
    public readonly rows: MarkdownInlineNode[][][],
    public readonly align: ('left' | 'center' | 'right' | null)[],
    public readonly locale: string = 'zh-CN'
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return Math.max(100, (1 + this.rows.length) * 36 + 50);
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-table-container';
    container.dataset.tableFrom = String(this.from);

    const t = (key: string, vars?: Record<string, string>) => translate(this.locale, key, vars);

    const toolbar = document.createElement('div');
    toolbar.className = 'cm-table-toolbar cm-table-floating-toolbar';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'cm-table-btn-add-row';
    addRowBtn.dataset.tableAction = 'add-row';
    addRowBtn.title = t('table.addRow');
    addRowBtn.textContent = t('table.btnRow');

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'cm-table-btn-add-col';
    addColBtn.dataset.tableAction = 'add-column';
    addColBtn.title = t('table.addColumn');
    addColBtn.textContent = t('table.btnCol');

    const delRowBtn = document.createElement('button');
    delRowBtn.type = 'button';
    delRowBtn.className = 'cm-table-btn-del-row';
    delRowBtn.dataset.tableAction = 'delete-row';
    delRowBtn.title = t('table.deleteRow');
    delRowBtn.textContent = t('table.btnDelRow');

    const delColBtn = document.createElement('button');
    delColBtn.type = 'button';
    delColBtn.className = 'cm-table-btn-del-col';
    delColBtn.dataset.tableAction = 'delete-column';
    delColBtn.title = t('table.deleteColumn');
    delColBtn.textContent = t('table.btnDelCol');

    const alignLeftBtn = document.createElement('button');
    alignLeftBtn.type = 'button';
    alignLeftBtn.className = 'cm-table-btn-align-left';
    alignLeftBtn.dataset.tableAction = 'align-left';
    alignLeftBtn.title = t('table.alignLeft');
    alignLeftBtn.innerHTML = `${TABLE_ALIGN_LEFT_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignLeft')}</span>`;

    const alignCenterBtn = document.createElement('button');
    alignCenterBtn.type = 'button';
    alignCenterBtn.className = 'cm-table-btn-align-center';
    alignCenterBtn.dataset.tableAction = 'align-center';
    alignCenterBtn.title = t('table.alignCenter');
    alignCenterBtn.innerHTML = `${TABLE_ALIGN_CENTER_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignCenter')}</span>`;

    const alignRightBtn = document.createElement('button');
    alignRightBtn.type = 'button';
    alignRightBtn.className = 'cm-table-btn-align-right';
    alignRightBtn.dataset.tableAction = 'align-right';
    alignRightBtn.title = t('table.alignRight');
    alignRightBtn.innerHTML = `${TABLE_ALIGN_RIGHT_ICON_SVG}<span class="cm-table-btn-text">${t('table.alignRight')}</span>`;

    const gridPickerBtn = document.createElement('button');
    gridPickerBtn.type = 'button';
    gridPickerBtn.className = 'cm-table-btn-grid-picker';
    gridPickerBtn.dataset.tableAction = 'grid-picker';
    gridPickerBtn.title = t('table.resizeTable');
    gridPickerBtn.innerHTML = `${TABLE_GRID_ICON_SVG}<span class="cm-table-btn-text">${t('table.btnResize')}</span>`;

    const delTableBtn = document.createElement('button');
    delTableBtn.type = 'button';
    delTableBtn.className = 'cm-table-btn-del-table';
    delTableBtn.dataset.tableAction = 'delete-table';
    delTableBtn.title = t('table.deleteTable');
    delTableBtn.innerHTML = `${TABLE_TRASH_ICON_SVG}<span class="cm-table-btn-text">${t('table.btnDelete')}</span>`;

    // 8x10 Grid Resizer popover
    const gridPopover = document.createElement('div');
    gridPopover.className = 'cm-table-grid-popover';

    const gridMatrix = document.createElement('div');
    gridMatrix.className = 'cm-table-grid-matrix';

    const gridFooter = document.createElement('div');
    gridFooter.className = 'cm-table-grid-footer';

    const MAX_ROWS = 10;
    const MAX_COLS = 8;
    const gridCells: HTMLDivElement[][] = [];

    for (let r = 0; r < MAX_ROWS; r++) {
      gridCells[r] = [];
      for (let c = 0; c < MAX_COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cm-table-grid-cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        gridMatrix.appendChild(cell);
        gridCells[r]![c] = cell;
      }
    }

    const highlightGrid = (rows: number, cols: number) => {
      for (let r = 0; r < MAX_ROWS; r++) {
        for (let c = 0; c < MAX_COLS; c++) {
          gridCells[r]![c]!.classList.toggle('is-highlighted', r < rows && c < cols);
        }
      }
      gridFooter.textContent = t('table.gridFooter', { rows: String(rows), cols: String(cols) });
    };

    gridMatrix.addEventListener('mousemove', (e) => {
      const target = (e.target as HTMLElement).closest('.cm-table-grid-cell') as HTMLElement | null;
      if (!target) return;
      const r = parseInt(target.dataset.row ?? '0', 10);
      const c = parseInt(target.dataset.col ?? '0', 10);
      highlightGrid(r + 1, c + 1);
    });

    gridMatrix.addEventListener('mouseleave', () => {
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const curRows = Math.min(MAX_ROWS, 1 + currentWidget.rows.length);
      const curCols = Math.min(MAX_COLS, currentWidget.headers.length);
      highlightGrid(curRows, curCols);
    });

    gridMatrix.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (e.target as HTMLElement).closest('.cm-table-grid-cell') as HTMLElement | null;
      if (!target || view.state.readOnly) return;
      const targetRows = parseInt(target.dataset.row ?? '0', 10) + 1;
      const targetCols = parseInt(target.dataset.col ?? '0', 10) + 1;
      gridPopover.classList.remove('is-visible');

      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableResizeTransaction(source, tableCtx, targetRows, targetCols);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    gridPickerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isVisible = gridPopover.classList.contains('is-visible');
      if (isVisible) {
        gridPopover.classList.remove('is-visible');
      } else {
        const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
        const curRows = Math.min(MAX_ROWS, 1 + currentWidget.rows.length);
        const curCols = Math.min(MAX_COLS, currentWidget.headers.length);
        highlightGrid(curRows, curCols);
        gridPopover.classList.add('is-visible');
      }
    });

    gridPopover.appendChild(gridMatrix);
    gridPopover.appendChild(gridFooter);

    const onDocClick = (e: MouseEvent) => {
      if (!gridPopover.contains(e.target as Node) && !gridPickerBtn.contains(e.target as Node)) {
        gridPopover.classList.remove('is-visible');
      }
    };
    document.addEventListener('click', onDocClick);
    (container as any).__nexusTableDocClickHandler = onDocClick;

    (container as any).__nexusTableWidget = this;
    (container as any).__nexusTableLocale = this.locale;

    const updateButtons = () => {
      const isRo = view.state.readOnly;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const target = view.state.field(tableTargetField, false);
      const activeRow =
        target && target.tableFrom === currentWidget.from ? target.activeRow : null;
      const activeCol =
        target && target.tableFrom === currentWidget.from ? target.activeCol : null;

      addRowBtn.disabled = isRo;
      addColBtn.disabled = isRo;
      delRowBtn.disabled = isRo || activeRow === null || activeRow < 0;
      delColBtn.disabled = isRo || activeCol === null || currentWidget.headers.length <= 1;
      alignLeftBtn.disabled = isRo || activeCol === null;
      alignCenterBtn.disabled = isRo || activeCol === null;
      alignRightBtn.disabled = isRo || activeCol === null;
      delTableBtn.disabled = isRo;
      gridPickerBtn.disabled = isRo;

      const currentAlign =
        activeCol !== null && currentWidget.align && activeCol < currentWidget.align.length
          ? currentWidget.align[activeCol]
          : null;
      alignLeftBtn.classList.toggle('is-active', currentAlign === 'left');
      alignCenterBtn.classList.toggle('is-active', currentAlign === 'center');
      alignRightBtn.classList.toggle('is-active', currentAlign === 'right');
    };

    (container as any).__nexusUpdateTableToolbar = updateButtons;

    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const target = view.state.field(tableTargetField, false);
      const activeRow =
        target && target.tableFrom === currentWidget.from ? target.activeRow : null;
      const targetRowIndex =
        activeRow !== null ? (activeRow === -1 ? 0 : activeRow + 1) : undefined;

      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddRowTransaction(source, tableCtx, targetRowIndex);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    addColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const target = view.state.field(tableTargetField, false);
      const activeCol =
        target && target.tableFrom === currentWidget.from ? target.activeCol : null;
      const targetColIndex = activeCol !== null ? activeCol + 1 : undefined;

      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddColumnTransaction(source, tableCtx, targetColIndex);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    delRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeRow =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeRow : null;
      if (view.state.readOnly || activeRow === null || activeRow < 0) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && tableCtx.rows.length > 0 && activeRow < tableCtx.rows.length) {
        const tx = createTableDeleteRowTransaction(source, tableCtx, activeRow);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent,
            effects: setTableTargetEffect.of(null)
          });
        }
      }
    });

    delColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeCol =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeCol : null;
      if (view.state.readOnly || activeCol === null) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && tableCtx.headers.length > 1 && activeCol < tableCtx.headers.length) {
        const tx = createTableDeleteColumnTransaction(source, tableCtx, activeCol);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent,
            effects: setTableTargetEffect.of(null)
          });
        }
      }
    });

    delTableBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableDeleteTransaction(source, tableCtx);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent,
            effects: setTableTargetEffect.of(null)
          });
        }
      }
    });

    const createAlignHandler = (align: 'left' | 'center' | 'right') => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const currentTarget = view.state.field(tableTargetField, false);
      const activeCol =
        currentTarget && currentTarget.tableFrom === currentWidget.from ? currentTarget.activeCol : null;
      if (view.state.readOnly || activeCol === null) return;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx && activeCol < tableCtx.headers.length) {
        const tx = createTableSetAlignTransaction(source, tableCtx, activeCol, align);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    };

    alignLeftBtn.addEventListener('click', createAlignHandler('left'));
    alignCenterBtn.addEventListener('click', createAlignHandler('center'));
    alignRightBtn.addEventListener('click', createAlignHandler('right'));

    updateButtons();

    toolbar.appendChild(addRowBtn);
    toolbar.appendChild(addColBtn);
    toolbar.appendChild(delRowBtn);
    toolbar.appendChild(delColBtn);
    toolbar.appendChild(alignLeftBtn);
    toolbar.appendChild(alignCenterBtn);
    toolbar.appendChild(alignRightBtn);
    toolbar.appendChild(gridPickerBtn);
    toolbar.appendChild(delTableBtn);
    toolbar.appendChild(gridPopover);
    container.appendChild(toolbar);

    // Floating hover handles for adding rows and columns
    const handleAddRow = document.createElement('div');
    handleAddRow.className = 'cm-table-handle-add-row';
    handleAddRow.title = t('table.addRow');
    handleAddRow.textContent = '+';
    handleAddRow.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddRowTransaction(source, tableCtx);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    const handleAddCol = document.createElement('div');
    handleAddCol.className = 'cm-table-handle-add-col';
    handleAddCol.title = t('table.addColumn');
    handleAddCol.textContent = '+';
    handleAddCol.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
      const source = view.state.doc.toString();
      const tableCtx = findTableAtPosition(source, currentWidget.from);
      if (tableCtx) {
        const tx = createTableAddColumnTransaction(source, tableCtx);
        if (tx) {
          view.dispatch({
            changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
            userEvent: tx.userEvent
          });
        }
      }
    });

    container.appendChild(handleAddRow);
    container.appendChild(handleAddCol);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'cm-visual-table-scroll';
    const table = this.buildTableDOM(view, container);
    scrollWrap.appendChild(table);
    container.appendChild(scrollWrap);

    return container;
  }

  private buildTableDOM(view: EditorView, container: HTMLElement): HTMLTableElement {
    const table = document.createElement('table');
    table.className = 'cm-visual-table';

    const target = view.state.field(tableTargetField, false);
    const activeRow = target && target.tableFrom === this.from ? target.activeRow : null;
    const activeCol = target && target.tableFrom === this.from ? target.activeCol : null;

    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    this.headers.forEach((cell, colIdx) => {
      const th = document.createElement('th');
      th.dataset.row = '-1';
      th.dataset.col = String(colIdx);
      if (activeRow === -1 && activeCol === colIdx) {
        th.classList.add('is-active');
      }
      const align = this.align[colIdx];
      if (align) th.style.textAlign = align;
      populateTableCellDOM(th, cell);

      th.addEventListener('click', (e) => {
        e.stopPropagation();
        table.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
        th.classList.add('is-active');
        const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
        view.dispatch({
          effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: -1, activeCol: colIdx })
        });
        const updateButtons = (container as any).__nexusUpdateTableToolbar;
        if (typeof updateButtons === 'function') updateButtons();
        if (view.state.readOnly) return;
        this.startCellEdit(view, th, -1, colIdx);
      });

      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');
      row.forEach((cell, colIdx) => {
        const td = document.createElement('td');
        td.dataset.row = String(rowIdx);
        td.dataset.col = String(colIdx);
        if (activeRow === rowIdx && activeCol === colIdx) {
          td.classList.add('is-active');
        }
        const align = this.align[colIdx];
        if (align) td.style.textAlign = align;
        populateTableCellDOM(td, cell);

        td.addEventListener('click', (e) => {
          e.stopPropagation();
          table.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
          td.classList.add('is-active');
          const currentWidget: TableBlockWidget = (container as any).__nexusTableWidget || this;
          view.dispatch({
            effects: setTableTargetEffect.of({ tableFrom: currentWidget.from, activeRow: rowIdx, activeCol: colIdx })
          });
          const updateButtons = (container as any).__nexusUpdateTableToolbar;
          if (typeof updateButtons === 'function') updateButtons();
          if (view.state.readOnly) return;
          this.startCellEdit(view, td, rowIdx, colIdx);
        });

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  private startCellEdit(
    view: EditorView,
    cellEl: HTMLElement,
    rowIndex: number,
    colIndex: number
  ): void {
    if (view.state.readOnly || cellEl.querySelector('.cm-table-cell-editor')) return;

    let contentWrap = cellEl.querySelector('.cm-table-cell-content') as HTMLElement | null;
    if (!contentWrap) {
      contentWrap = document.createElement('div');
      contentWrap.className = 'cm-table-cell-content';
      while (cellEl.firstChild) {
        contentWrap.appendChild(cellEl.firstChild);
      }
      cellEl.appendChild(contentWrap);
    }

    contentWrap.classList.add('cm-table-cell-editor');
    contentWrap.contentEditable = 'true';

    // Reveal delimiters in the active cell
    contentWrap.querySelectorAll('.cm-visual-hidden-delimiter').forEach((el) => {
      el.className = 'cm-visual-delimiter-revealed';
    });

    // Remove placeholder span if present
    const placeholder = contentWrap.querySelector('.cm-table-cell-placeholder');
    if (placeholder) {
      placeholder.remove();
      if (!contentWrap.childNodes.length) {
        contentWrap.appendChild(document.createElement('br'));
      }
    }

    // Baseline captured from the rendered DOM rather than from the AST: activating
    // a cell and leaving it without editing must never dispatch a transaction.
    const baselineValue = serializeTableCellDOM(contentWrap);

    // The cell editor is an editable island nested inside CodeMirror's own editable
    // content. Chromium's native SelectAll therefore resolves against the whole
    // editor, so a plain Ctrl/Cmd+A would select the entire document and the next
    // keystroke would replace the file. Scope it to the cell instead.
    const selectAllCellContent = () => {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(contentWrap!);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    // Property compatibility: .value getter/setter
    Object.defineProperty(contentWrap, 'value', {
      get() {
        return serializeTableCellDOM(contentWrap!);
      },
      set(val: string) {
        contentWrap!.textContent = val;
      },
      configurable: true
    });

    // Selection helper for compatibility
    (contentWrap as any).select = selectAllCellContent;

    contentWrap.focus();

    const controller = createSubEditorController(view, () => {
      if (cellEl.contains(contentWrap)) {
        contentWrap!.contentEditable = 'false';
        contentWrap!.classList.remove('cm-table-cell-editor');
        contentWrap!.querySelectorAll('.cm-visual-delimiter-revealed').forEach((el) => {
          el.className = 'cm-visual-hidden-delimiter';
        });
        if (!contentWrap!.textContent?.trim() && !contentWrap!.querySelector('br')) {
          contentWrap!.textContent = '';
          const placeholder = document.createElement('span');
          placeholder.className = 'cm-table-cell-placeholder';
          const br = document.createElement('br');
          placeholder.appendChild(br);
          contentWrap!.appendChild(placeholder);
        }
      }
    });
    const { signal } = controller;

    let isComposing = false;
    contentWrap.addEventListener(
      'compositionstart',
      () => {
        isComposing = true;
      },
      { signal }
    );
    contentWrap.addEventListener(
      'compositionend',
      () => {
        isComposing = false;
      },
      { signal }
    );

    const commit = () => {
      if (!controller.isActive() || view.state.readOnly) {
        controller.close();
        return;
      }

      const newValue = serializeTableCellDOM(contentWrap!);
      if (newValue === baselineValue) {
        controller.close();
        return;
      }
      const source = view.state.doc.toString();
      if (this.to > source.length || source.slice(this.from, this.to) !== this.raw) {
        controller.close();
        return;
      }
      const tableCtx = findTableAtPosition(source, this.from);
      if (tableCtx) {
        const lines = splitTableLines(tableCtx.raw, tableCtx.tableRange.from);
        const targetLineIdx = rowIndex === -1 ? 0 : 2 + rowIndex;
        if (targetLineIdx < lines.length) {
          const line = lines[targetLineIdx]!;
          const match = line.text.match(/^([ \t]*(?:>[ \t]*)*)/);
          const prefixLen = match ? match[0]!.length : 0;
          const cleanText = line.text.slice(prefixLen);
          const ranges = getRowCellRanges(cleanText, line.from + prefixLen);
          if (colIndex < ranges.length) {
            const r = ranges[colIndex]!;
            const cellCtx: TableCellContext = {
              tableRange: tableCtx.tableRange,
              cellRange: { from: r.from, to: r.to },
              slotRange: { from: r.slotStart + prefixLen, to: r.slotEnd + prefixLen },
              rowIndex,
              colIndex,
              cellRaw: cleanText.slice(r.slotStart, r.slotEnd),
              tableContext: tableCtx
            };
            const tx = createTableCellEditTransaction(source, cellCtx, newValue);
            if (tx) {
              controller.close();
              view.dispatch({
                changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
                userEvent: tx.userEvent
              });
              return;
            }
          }
        }
      }
      controller.close();
    };

    const initialContainer = cellEl.closest('.cm-visual-table-container') as HTMLElement | null;
    const currentTableFrom =
      (initialContainer as any)?.__nexusTableWidget?.from ?? this.from;

    const findCurrentTableContainer = (): HTMLElement | null => {
      if (initialContainer && initialContainer.isConnected) return initialContainer;
      return view.dom.querySelector(
        `.cm-visual-table-container[data-table-from="${currentTableFrom}"]`
      );
    };

    contentWrap.addEventListener(
      'keydown',
      (e) => {
        if (!controller.isActive() || isComposing || e.isComposing) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          e.stopPropagation();
          selectAllCellContent();
          return;
        }
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.setEndAfter(br);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            contentWrap!.appendChild(document.createElement('br'));
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          const targetContainer = findCurrentTableContainer();
          const currentWidget: TableBlockWidget =
            (targetContainer as any)?.__nexusTableWidget || (initialContainer as any)?.__nexusTableWidget || this;
          const nextRow = rowIndex === -1 ? 0 : rowIndex + 1;
          if (nextRow < currentWidget.rows.length) {
            const lifecycle = view.plugin(subEditorLifecyclePlugin);
            const currentGen = lifecycle ? lifecycle.generation : 0;
            queueMicrotask(() => {
              if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
              const liveContainer = findCurrentTableContainer();
              const targetCell = liveContainer?.querySelector(
                `.cm-visual-table [data-row="${nextRow}"][data-col="${colIndex}"]`
              ) as HTMLElement | null;
              if (targetCell && !view.state.readOnly) {
                targetCell.click();
              }
            });
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          controller.close();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          const targetContainer = findCurrentTableContainer();
          const currentWidget: TableBlockWidget =
            (targetContainer as any)?.__nexusTableWidget || (initialContainer as any)?.__nexusTableWidget || this;
          const totalCols = currentWidget.headers.length;
          const totalRows = currentWidget.rows.length;

          if (!e.shiftKey) {
            // Check if last cell in the table
            if (rowIndex === totalRows - 1 && colIndex === totalCols - 1) {
              const source = view.state.doc.toString();
              const tableCtx = findTableAtPosition(source, currentWidget.from);
              if (tableCtx) {
                const tx = createTableAddRowTransaction(source, tableCtx);
                if (tx) {
                  view.dispatch({
                    changes: tx.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
                    userEvent: tx.userEvent
                  });
                  const newRowIdx = rowIndex + 1;
                  const lifecycle = view.plugin(subEditorLifecyclePlugin);
                  const currentGen = lifecycle ? lifecycle.generation : 0;
                  queueMicrotask(() => {
                    if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                    const liveContainer = findCurrentTableContainer();
                    const targetCell = liveContainer?.querySelector(
                      `.cm-visual-table [data-row="${newRowIdx}"][data-col="0"]`
                    ) as HTMLElement | null;
                    if (targetCell && !view.state.readOnly) {
                      targetCell.click();
                    }
                  });
                  return;
                }
              }
            }

            // Normal tab forward
            let nextRow = rowIndex;
            let nextCol = colIndex + 1;
            if (nextCol >= totalCols) {
              nextCol = 0;
              nextRow = rowIndex === -1 ? 0 : rowIndex + 1;
            }
            if (nextRow < totalRows) {
              const lifecycle = view.plugin(subEditorLifecyclePlugin);
              const currentGen = lifecycle ? lifecycle.generation : 0;
              queueMicrotask(() => {
                if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                const liveContainer = findCurrentTableContainer();
                const targetCell = liveContainer?.querySelector(
                  `.cm-visual-table [data-row="${nextRow}"][data-col="${nextCol}"]`
                ) as HTMLElement | null;
                if (targetCell && !view.state.readOnly) {
                  targetCell.click();
                }
              });
            }
          } else {
            // Shift + Tab backward
            let prevRow = rowIndex;
            let prevCol = colIndex - 1;
            if (prevCol < 0) {
              prevCol = totalCols - 1;
              prevRow = rowIndex === 0 ? -1 : rowIndex - 1;
            }
            if (prevRow >= -1) {
              const lifecycle = view.plugin(subEditorLifecyclePlugin);
              const currentGen = lifecycle ? lifecycle.generation : 0;
              queueMicrotask(() => {
                if (!lifecycle || lifecycle.disposed || lifecycle.generation !== currentGen) return;
                const liveContainer = findCurrentTableContainer();
                const targetCell = liveContainer?.querySelector(
                  `.cm-visual-table [data-row="${prevRow}"][data-col="${prevCol}"]`
                ) as HTMLElement | null;
                if (targetCell && !view.state.readOnly) {
                  targetCell.click();
                }
              });
            }
          }
        }
      },
      { signal }
    );

    contentWrap.addEventListener(
      'blur',
      () => {
        if (controller.isActive() && !isComposing) {
          commit();
        }
      },
      { signal }
    );
  }

  public ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    if (
      target.isContentEditable ||
      target.closest?.('[contenteditable="true"]') ||
      target.closest?.('.cm-table-cell-editor') ||
      target.closest?.('.cm-table-floating-toolbar') ||
      target.closest?.('.cm-table-grid-popover')
    ) {
      return true;
    }
    return false;
  }

  public override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!dom.classList.contains('cm-visual-table-container')) {
      return false;
    }
    (dom as any).__nexusTableWidget = this;
    dom.dataset.tableFrom = String(this.from);

    const scrollWrap = dom.querySelector('.cm-visual-table-scroll') as HTMLElement | null;
    const oldTable = dom.querySelector('.cm-visual-table');
    const newTable = this.buildTableDOM(view, dom);

    if (scrollWrap) {
      if (oldTable && oldTable.parentElement === scrollWrap) {
        scrollWrap.replaceChild(newTable, oldTable);
      } else {
        scrollWrap.appendChild(newTable);
      }
    } else {
      const newScrollWrap = document.createElement('div');
      newScrollWrap.className = 'cm-visual-table-scroll';
      newScrollWrap.appendChild(newTable);
      dom.appendChild(newScrollWrap);
    }

    if ((dom as any).__nexusTableLocale !== this.locale) {
      (dom as any).__nexusTableLocale = this.locale;
      const t = (key: string, vars?: Record<string, string>) => translate(this.locale, key, vars);

      const addRowBtn = dom.querySelector('.cm-table-btn-add-row') as HTMLButtonElement | null;
      if (addRowBtn) {
        addRowBtn.title = t('table.addRow');
        addRowBtn.textContent = t('table.btnRow');
      }
      const addColBtn = dom.querySelector('.cm-table-btn-add-col') as HTMLButtonElement | null;
      if (addColBtn) {
        addColBtn.title = t('table.addColumn');
        addColBtn.textContent = t('table.btnCol');
      }
      const delRowBtn = dom.querySelector('.cm-table-btn-del-row') as HTMLButtonElement | null;
      if (delRowBtn) {
        delRowBtn.title = t('table.deleteRow');
        delRowBtn.textContent = t('table.btnDelRow');
      }
      const delColBtn = dom.querySelector('.cm-table-btn-del-col') as HTMLButtonElement | null;
      if (delColBtn) {
        delColBtn.title = t('table.deleteColumn');
        delColBtn.textContent = t('table.btnDelCol');
      }
      const alignLeftBtn = dom.querySelector('.cm-table-btn-align-left') as HTMLButtonElement | null;
      if (alignLeftBtn) {
        alignLeftBtn.title = t('table.alignLeft');
        const textSpan = alignLeftBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignLeft');
      }
      const alignCenterBtn = dom.querySelector('.cm-table-btn-align-center') as HTMLButtonElement | null;
      if (alignCenterBtn) {
        alignCenterBtn.title = t('table.alignCenter');
        const textSpan = alignCenterBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignCenter');
      }
      const alignRightBtn = dom.querySelector('.cm-table-btn-align-right') as HTMLButtonElement | null;
      if (alignRightBtn) {
        alignRightBtn.title = t('table.alignRight');
        const textSpan = alignRightBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.alignRight');
      }
      const gridPickerBtn = dom.querySelector('.cm-table-btn-grid-picker') as HTMLButtonElement | null;
      if (gridPickerBtn) {
        gridPickerBtn.title = t('table.resizeTable');
        const textSpan = gridPickerBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.btnResize');
      }
      const delTableBtn = dom.querySelector('.cm-table-btn-del-table') as HTMLButtonElement | null;
      if (delTableBtn) {
        delTableBtn.title = t('table.deleteTable');
        const textSpan = delTableBtn.querySelector('.cm-table-btn-text');
        if (textSpan) textSpan.textContent = t('table.btnDelete');
      }
      const handleAddRow = dom.querySelector('.cm-table-handle-add-row') as HTMLElement | null;
      if (handleAddRow) {
        handleAddRow.title = t('table.addRow');
      }
      const handleAddCol = dom.querySelector('.cm-table-handle-add-col') as HTMLElement | null;
      if (handleAddCol) {
        handleAddCol.title = t('table.addColumn');
      }
    }

    const updateButtons = (dom as any).__nexusUpdateTableToolbar;
    if (typeof updateButtons === 'function') {
      updateButtons();
    }
    view.requestMeasure();
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    const onDocClick = (dom as any).__nexusTableDocClickHandler;
    if (onDocClick) {
      document.removeEventListener('click', onDocClick);
    }
  }
}

const COPY_ICON_SVG = `<svg class="cm-code-copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg class="cm-code-copy-icon cm-code-copy-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

function bindClipboardCopy(
  copyBtn: HTMLButtonElement,
  getText: () => string,
  setTimer: ((timer: ReturnType<typeof setTimeout> | null) => void) | undefined,
  t: (key: string) => string
): void {
  copyBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) {
      copyBtn.dataset.copyState = 'error';
      copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copyFailed')}</span>`;
      return;
    }
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        copyBtn.dataset.copyState = 'success';
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `${CHECK_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copied')}</span>`;
        const timer = setTimeout(() => {
          copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;
          copyBtn.classList.remove('copied');
          delete copyBtn.dataset.copyState;
          setTimer?.(null);
        }, 2000);
        setTimer?.(timer);
      })
      .catch(() => {
        copyBtn.dataset.copyState = 'error';
        copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Failed</span>`;
      });
  });
}

export class CodeBlockHeaderWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly firstLineTo: number,
    public readonly language: string | undefined,
    public readonly value: string,
    public readonly blockTo: number,
    /** 按钮文案依赖语言：进 eq() 才能让运行时切语言时重建 DOM，而不是留着旧文案。 */
    public readonly locale: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockHeaderWidget &&
      other.from === this.from &&
      other.firstLineTo === this.firstLineTo &&
      other.language === this.language &&
      other.value === this.value &&
      other.blockTo === this.blockTo &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const t = (key: string) => translate(view.state.facet(editorLocaleFacet), key);

    const container = document.createElement('div');
    container.className = 'cm-code-header-widget';

    const select = document.createElement('select');
    select.className = 'cm-code-language-select';
    select.disabled = view.state.readOnly;
    select.setAttribute('aria-label', 'Code block language');

    const languages = [...DEFAULT_CODE_LANGUAGES];
    const currentLang = this.language || '';
    // 用归一化后的语言键匹配预设项，`C++` / `C#` / `ts` 这类手写围栏信息
    // 应当选中已有预设，而不是追加一个重复的“自定义语言”选项。
    const currentKey = currentLang ? normalizeLanguage(currentLang) : '';
    const matchedPreset = currentKey
      ? languages.find((l) => l.value !== '' && normalizeLanguage(l.value) === currentKey)
      : undefined;
    if (currentLang && !matchedPreset) {
      languages.push({ label: currentLang, value: currentLang });
    }

    for (const lang of languages) {
      const opt = document.createElement('option');
      opt.value = lang.value;
      opt.textContent = lang.label;
      select.appendChild(opt);
    }

    // 所有 option 追加完成后再统一设置选中项：既不依赖 append 顺序，
    // 也避免 option.selected 在后续 append 时被实现重置。
    select.value = matchedPreset ? matchedPreset.value : currentLang;

    select.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    select.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dispatchCodeBlockLanguageChange(view, this.from, select.value.trim(), this.language);
    });

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cm-code-header-left';
    leftGroup.appendChild(select);

    const lineCount = this.value ? this.value.split(/\r?\n/).length : 0;
    if (lineCount > 0) {
      const countBadge = document.createElement('span');
      countBadge.className = 'cm-code-line-count';
      countBadge.textContent = `${lineCount} 行`;
      leftGroup.appendChild(countBadge);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.setAttribute('aria-label', t('codeBlock.copyAria'));
    copyBtn.title = t('codeBlock.copyAria');
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;

    const actions = document.createElement('div');
    actions.className = 'cm-code-header-actions';
    if (this.language === 'mermaid') {
      // 揭示态走的是普通代码块的逐行装饰，按钮得在这里再放一份，
      // 否则进了源码态就切不回预览（预览 widget 已经不在了）。
      actions.appendChild(createMermaidModeToggle(view, this.from, this.blockTo, true));
    }
    actions.appendChild(copyBtn);

    container.appendChild(leftGroup);
    container.appendChild(actions);

    bindClipboardCopy(
      copyBtn,
      () => this.value,
      (timer) => {
        if (this.copyTimer) clearTimeout(this.copyTimer);
        this.copyTimer = timer;
      },
      t
    );

    return container;
  }
}

export class CodeBlockExitWidget extends WidgetType {
  public constructor(public readonly to: number) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return other instanceof CodeBlockExitWidget && other.to === this.to;
  }

  public ignoreEvent(): boolean {
    return true;
  }

  public toDOM(view: EditorView): HTMLElement {
    const exit = document.createElement('div');
    exit.className = 'cm-code-exit-widget';
    exit.setAttribute('aria-hidden', 'true');

    exit.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || view.state.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const doc = view.state.doc;
      const targetPos = Math.min(this.to, doc.length);

      if (targetPos >= doc.length) {
        // At EOF: insert newline and place cursor on the new line
        const newline = doc.toString().includes('\r\n') ? '\r\n' : '\n';
        view.dispatch({
          changes: { from: targetPos, insert: newline },
          selection: EditorSelection.cursor(targetPos + newline.length),
          scrollIntoView: true
        });
      } else {
        // Not at EOF: targetPos is after the closing fence newline
        const isAlreadyEmptyLine =
          doc.sliceString(targetPos, targetPos + 1) === '\n' ||
          doc.sliceString(targetPos, targetPos + 2) === '\r\n';

        if (isAlreadyEmptyLine) {
          view.dispatch({
            selection: EditorSelection.cursor(targetPos),
            scrollIntoView: true
          });
        } else {
          const newline = doc.toString().includes('\r\n') ? '\r\n' : '\n';
          view.dispatch({
            changes: { from: targetPos, insert: newline },
            selection: EditorSelection.cursor(targetPos),
            scrollIntoView: true
          });
        }
      }
      view.focus();
    });

    return exit;
  }
}

/**
 * Mermaid 块的显示模式切换按钮。
 *
 * 它**只写 pin**，不直接翻转 DOM —— 渲染层按 `isMermaidSourceMode()` 派生结果，
 * 所以按钮与"点图揭示"两条路径共用同一个状态，不会互相覆盖：按钮是**粘性**的
 * （显式表态后一直有效），点图是**瞬时**的（光标一离开就回预览）。
 *
 * 两处渲染各要一份：预览 widget 的 header（`.cm-code-header`）与揭示态普通代码块的
 * header（`.cm-code-header-widget`）—— 揭示态走的是围栏代码块那套逐行装饰。
 */
function createMermaidModeToggle(
  view: EditorView,
  from: number,
  to: number,
  isSourceMode: boolean
): HTMLButtonElement {
  const locale = view.state.facet(editorLocaleFacet);
  const t = (key: string) => translate(locale, key);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-mermaid-toggle';
  // 标签描述"下一个动作"，与当前显示态相反
  button.textContent = isSourceMode ? t('codeBlock.showPreview') : t('codeBlock.showSource');
  button.title = isSourceMode ? t('codeBlock.showPreviewAria') : t('codeBlock.showSourceAria');
  button.setAttribute('aria-label', button.title);
  // 别让 CM 把光标挪走（mousedown 会冒泡到 contentDOM）
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!isSourceMode) {
      view.dispatch({ effects: setMermaidPreviewPinEffect.of({ from, mode: 'source' }) });
      return;
    }

    const pinPreview = setMermaidPreviewPinEffect.of({ from, mode: 'preview' });
    const head = view.state.selection.main.head;
    if (head > from && head <= to) {
      // 光标还在块内时只写 pin 不够：派生式里的光标项会立刻把它拉回源码态，
      // 按钮看起来"点了没反应"。顺手把光标移出块外。
      view.dispatch({ selection: { anchor: from }, effects: pinPreview });
    } else {
      view.dispatch({ effects: pinPreview });
    }
  });
  return button;
}

export class CodeBlockWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly language: string | undefined,
    public readonly value: string,
    /** 按钮文案依赖语言：进 eq() 才能让运行时切语言时重建 DOM，而不是留着旧文案。 */
    public readonly locale: string
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return 140;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.language === this.language &&
      other.value === this.value &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const t = (key: string) => translate(view.state.facet(editorLocaleFacet), key);

    const container = document.createElement('div');
    container.className = 'cm-visual-code-block';

    const header = document.createElement('div');
    header.className = 'cm-code-header';

    const langBadge = document.createElement('span');
    langBadge.className = 'cm-code-language';
    langBadge.textContent = this.language || 'text';
    header.appendChild(langBadge);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.setAttribute('aria-label', t('codeBlock.copyAria'));
    copyBtn.title = t('codeBlock.copyAria');
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;

    // 按钮是"进源码"的默认路径（`clickToReveal` 默认关）。
    const modeToggle = createMermaidModeToggle(view, this.from, this.to, false);
    const actions = document.createElement('div');
    actions.className = 'cm-code-header-actions';
    actions.appendChild(modeToggle);
    actions.appendChild(copyBtn);

    header.appendChild(actions);
    container.appendChild(header);

    bindClipboardCopy(
      copyBtn,
      () => this.value,
      (timer) => {
        if (this.copyTimer) clearTimeout(this.copyTimer);
        this.copyTimer = timer;
      },
      t
    );

    // 只有预览体，没有"源码态"——源码由**揭示**给出：点击预览把光标送进块内，
    // 下一次投影重建时整块替换消失，` ``` ` 围栏与正文变回真实文档文本，
    // 走普通代码块那套逐行装饰（可编辑、有高亮、自带 header 与复制按钮）。
    //
    // 早先的做法是在 widget 内部放一个 <pre> 和一个 Source/Preview 切换按钮：
    // 那个 <pre> 只是静态文本，真实文档被替换吞掉了，所以"Source 态"根本没法编辑。
    const previewEl = document.createElement('div');
    previewEl.className = 'cm-mermaid-preview';
    const host = view.state.facet(extensionHostFacet);
    mountExtension(
      host,
      { type: 'code-fence', from: this.from, to: this.to, text: this.value, language: this.language },
      previewEl,
      this.value,
      () => {
        previewEl.innerHTML = '';
        const previewPre = document.createElement('pre');
        previewPre.textContent = this.value;
        previewEl.appendChild(previewPre);
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    container.appendChild(previewEl);

    previewEl.addEventListener('mousedown', (event) => {
      // 设置关闭时（默认）点图不揭示：把事件交回 CM —— 被整块替换的范围承载不了光标，
      // CM 只能把它贴到 from / to 边界上，严格揭示判据不成立，所以块保持预览态。
      if (!view.state.facet(mermaidPreviewSettingsFacet).clickToReveal) return;
      event.preventDefault();
      event.stopPropagation();
      // 落点取代码正文起点（跳过开围栏与语言标记），光标直接落在可编辑的内容行上。
      const contentOffset = this.raw.indexOf(this.value);
      const anchor = this.from + (contentOffset > 0 ? contentOffset : 1);
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(anchor, this.to) } });
    });

    return container;
  }

  public destroy(): void {
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 块级公式进入编辑态时追加在块尾的**实时预览**。
 *
 * 单独一个 WidgetType 子类而不是给 BlockMathWidget 加 `preview` 开关：
 * 两个变体的 className、可交互性和 `eq()` 语义都不同，用类区分更清楚，
 * 也避免"构造参数没送达"这类隐蔽问题。
 */
export class BlockMathPreviewWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

  private control?: EditorExtensionControl;

  /** 追加的块级 widget：给一个下界，免得高度表在测量前把它算成 0 导致滚动跳动。 */
  public get estimatedHeight(): number {
    return 48;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof BlockMathPreviewWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula
    );
  }

  public updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      view.requestMeasure();
      return true;
    }
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math cm-visual-block-math-preview';
    const host = view.state.facet(extensionHostFacet);
    this.control = mountExtension(
      host,
      { type: 'block-math', from: this.from, to: this.to, text: this.formula },
      container,
      this.formula,
      () => {
        container.innerHTML = '';
        container.textContent = `$$ ${this.formula} $$`;
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    (container as any).__nexusExtensionControl = this.control;
    return container;
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 块级公式 `$$...$$` 的投影。两个变体：
 *
 * - **渲染态**（`preview: false`）：整块替换成 KaTeX 结果；点击/回车把光标送进源码。
 * - **预览态**（`preview: true`）：只在光标进入块内时**追加在块尾**，与源码并存，
 *   边改边看。markra 的 `markra-math-render-active-preview` 就是这个思路。
 */
export class BlockMathWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

  private control?: EditorExtensionControl;

  public get estimatedHeight(): number {
    return 60;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof BlockMathWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula
    );
  }

  public updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      view.requestMeasure();
      return true;
    }
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math';
    const host = view.state.facet(extensionHostFacet);

    this.control = mountExtension(
      host,
      { type: 'block-math', from: this.from, to: this.to, text: this.formula },
      container,
      this.formula,
      () => {
        // 扩展不可用（懒加载失败 / 宿主没注册）：退化成源码文本，不能什么都不显示。
        container.innerHTML = '';
        container.textContent = `$$ ${this.formula} $$`;
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    (container as any).__nexusExtensionControl = this.control;

    {
      // 渲染态是整块替换，点击会被它吞掉（CM 只能把光标贴到边界），
      // 而揭示判据要求光标严格落在块内，所以激活手势必须自己接管。
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
      container.setAttribute(
        'aria-label',
        translate(view.state.facet(editorLocaleFacet), 'editor.editBlockMath')
      );
      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        activateMathSource(view, this.from, this.to, this.raw);
      };
      // 用 mousedown 而不是 click：CM 的落光标逻辑也走 mousedown，晚一步就先把光标贴到边界了。
      container.addEventListener('mousedown', activate);
      container.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
      });
    }

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class RawBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof RawBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-raw-block';
    container.textContent = this.raw;

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-raw-block-editor')) return;

      const trailing = this.raw.match(/(\r?\n)+$/);
      const trailingNl = trailing ? trailing[0]! : '';

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-raw-block-editor';
      textarea.value = this.raw.slice(0, this.raw.length - trailingNl.length);

      container.textContent = '';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        if (container.contains(textarea)) textarea.remove();
        container.textContent = this.raw;
      });
      const { signal } = controller;

      let isComposing = false;
      textarea.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      textarea.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newRaw = textarea.value + trailingNl;
        controller.close();
        view.dispatch({
          changes: [{ from: this.from, to: this.to, insert: newRaw }],
          userEvent: RAW_BLOCK_EDIT_USER_EVENT
        });
      };

      textarea.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      textarea.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
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
      const isMermaid = blockNode.language === 'mermaid' && !isQuoteNested;
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

/** 空 pin 表：让 `buildVisualProjection` 的默认参数不用每次 new 一个。 */
const EMPTY_MERMAID_PINS: ReadonlyMap<number, MermaidPreviewPin> = new Map();

/** Mermaid 块的显示模式。`auto` 交给派生逻辑，`source` / `preview` 是用户按按钮钉住的显式选择。 */
export type MermaidPreviewPin = 'source' | 'preview';

/** 用户对 Mermaid 块"怎么进源码"的偏好。 */
export interface MermaidPreviewSettings {
  /**
   * 点击预览图是否直接露出源码。
   *
   * 关（默认）时只有 header 上的按钮能切到源码 —— 按钮是显式动作、效果可预期；
   * 开时点图 = 瞥一眼源码，光标一离开就回到预览。
   */
  clickToReveal: boolean;
}

export const DEFAULT_MERMAID_PREVIEW_SETTINGS: MermaidPreviewSettings = {
  clickToReveal: false
};

/**
 * 应用级偏好注入点。
 *
 * 投影层**不读** localStorage —— 设置由宿主（`platform.ts`）持久化后经这个 facet 注入，
 * 与 `editorLocaleFacet` 同一套做法，包间边界不破。
 */
export const mermaidPreviewSettingsFacet = Facet.define<
  MermaidPreviewSettings,
  MermaidPreviewSettings
>({
  combine: (values) => values[0] ?? DEFAULT_MERMAID_PREVIEW_SETTINGS
});

export const mermaidPreviewCompartment = new Compartment();

/** 运行时改设置：reconfigure 后投影 field 会重建（见 `visualProjectionField.update`）。 */
export function setMermaidPreviewSettings(view: EditorView, settings: MermaidPreviewSettings): void {
  view.dispatch({
    effects: mermaidPreviewCompartment.reconfigure(mermaidPreviewSettingsFacet.of(settings))
  });
}

/**
 * 每个 Mermaid 块钉住的显示模式，键是块的起始偏移。
 *
 * 这是**文档态**（跟着块走），所以放 StateField 而不是应用偏好：位置随
 * `changes.mapPos` 映射，块被删掉后自然失配、不残留。
 */
export const setMermaidPreviewPinEffect = StateEffect.define<{
  from: number;
  mode: MermaidPreviewPin | null;
}>();

export const mermaidPreviewPinField = StateField.define<Map<number, MermaidPreviewPin>>({
  create() {
    return new Map();
  },
  update(pins, transaction) {
    let next = pins;
    if (transaction.docChanged) {
      const mapped = new Map<number, MermaidPreviewPin>();
      for (const [position, mode] of pins) {
        mapped.set(transaction.changes.mapPos(position, 1), mode);
      }
      next = mapped;
    }
    for (const effect of transaction.effects) {
      if (!effect.is(setMermaidPreviewPinEffect)) continue;
      if (next === pins) next = new Map(pins);
      const { from, mode } = effect.value;
      if (mode === null) {
        next.delete(from);
      } else {
        next.set(from, mode);
      }
    }
    return next;
  }
});

/** Visual surface 的 source-aligned decoration field。 */
export const visualProjectionField = StateField.define<DecorationSet>({
  create(state) {
    const isFocused = state.field(visualFocusField, false);
    const docDir = state.field(documentDirectoryField, false);
    const locale = state.facet(editorLocaleFacet);
    return buildVisualProjection(
      state.doc.toString(),
      state.selection,
      isFocused,
      docDir,
      locale,
      state.field(mermaidPreviewPinField, false)
    );
  },
  update(decorations, transaction) {
    const isFocused = transaction.state.field(visualFocusField, false);
    const docDir = transaction.state.field(documentDirectoryField, false);
    const locale = transaction.state.facet(editorLocaleFacet);

    const prevFocused = transaction.startState.field(visualFocusField, false);
    const prevDocDir = transaction.startState.field(documentDirectoryField, false);
    const prevLocale = transaction.startState.facet(editorLocaleFacet);
    const focusChanged = isFocused !== prevFocused;
    const docDirChanged = docDir !== prevDocDir;
    const localeChanged = locale !== prevLocale;
    const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    // pin 表在没变时返回同一个引用，所以身份比较就够。
    const mermaidPins = transaction.state.field(mermaidPreviewPinField, false);
    const mermaidPinsChanged =
      mermaidPins !== transaction.startState.field(mermaidPreviewPinField, false);

    if (
      transaction.docChanged ||
      focusChanged ||
      docDirChanged ||
      localeChanged ||
      readOnlyChanged ||
      selectionChanged ||
      mermaidPinsChanged ||
      transaction.effects.some((e) => e.is(setComposingEffect) && !e.value)
    ) {
      if (isEditorComposing(transaction.state)) {
        return decorations.map(transaction.changes);
      }
      return buildVisualProjection(
        transaction.state.doc.toString(),
        transaction.state.selection,
        isFocused,
        docDir,
        locale,
        mermaidPins
      );
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export const tableWidgetSyncPlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.state.field(tableTargetField, false) !==
          update.startState.field(tableTargetField, false) ||
        update.state.readOnly !== update.startState.readOnly
      ) {
        const containers = update.view.dom.querySelectorAll<HTMLElement>(
          '.cm-visual-table-container'
        );
        containers.forEach((container) => {
          const updater = (container as any).__nexusUpdateTableToolbar;
          if (typeof updater === 'function') {
            updater();
          }
        });
      }
    }
  }
);

interface HoveredCodeBlockState {
  readonly decorations: DecorationSet;
  readonly from: number | null;
}

/**
 * 设置/清除当前悬停代码块起始位置的状态效果。
 */
export const setHoveredCodeBlockEffect = StateEffect.define<number | null>({
  map(value, changes) {
    return value === null ? null : changes.mapPos(value, 1);
  }
});

/**
 * 悬停代码块 StateField：为当前悬停代码块的首行挂载 `data-code-block-hovered="true"` 属性，
 * 触发语言选择与复制按钮的平滑淡入显示。
 */
export const hoveredCodeBlockField = StateField.define<HoveredCodeBlockState>({
  create() {
    return { decorations: Decoration.none, from: null };
  },
  update(prev, tr) {
    let from = tr.docChanged && prev.from !== null ? tr.changes.mapPos(prev.from, 1) : prev.from;
    for (const effect of tr.effects) {
      if (effect.is(setHoveredCodeBlockEffect)) {
        from = effect.value;
      }
    }
    if (!tr.docChanged && from === prev.from) {
      return prev;
    }
    if (from === null) {
      return { decorations: Decoration.none, from: null };
    }
    try {
      const line = tr.state.doc.lineAt(from);
      return {
        decorations: Decoration.set([
          Decoration.line({
            attributes: { 'data-code-block-hovered': 'true' }
          }).range(line.from)
        ]),
        from
      };
    } catch {
      return { decorations: Decoration.none, from: null };
    }
  },
  provide: (field) => EditorView.decorations.from(field, (val) => val.decorations)
});

/**
 * 代码块鼠标悬停事件监听插件：
 * 基于 DOM `[data-code-block-from]` 极速查找代码块，无需 AST 遍历。
 */
export const codeBlockHoverPlugin = EditorView.domEventHandlers({
  mouseleave(_event, view) {
    const current = view.state.field(hoveredCodeBlockField, false);
    if (current && current.from !== null) {
      view.dispatch({ effects: setHoveredCodeBlockEffect.of(null) });
    }
    return false;
  },
  mousemove(event, view) {
    const target = event.target instanceof Element ? event.target : null;
    const rawFrom = target?.closest<HTMLElement>('[data-code-block-from]')?.dataset.codeBlockFrom;
    const from = rawFrom !== undefined && rawFrom !== '' ? Number(rawFrom) : null;
    const currentFrom = view.state.field(hoveredCodeBlockField, false)?.from ?? null;

    if (from !== currentFrom) {
      view.dispatch({ effects: setHoveredCodeBlockEffect.of(from) });
    }
    return false;
  }
});

/** Visual surface 的基础扩展；不创建第二份文档。 */
export const visualProjectionExtensions: Extension[] = [
  visualFocusField,
  visualFocusPlugin,
  documentDirectoryField,
  tableTargetField,
  tableWidgetSyncPlugin,
  visualProjectionField,
  mermaidPreviewPinField,
  mermaidPreviewCompartment.of(mermaidPreviewSettingsFacet.of(DEFAULT_MERMAID_PREVIEW_SETTINGS)),
  subEditorLifecyclePlugin,
  hoveredCodeBlockField,
  codeBlockHoverPlugin
];
