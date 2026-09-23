import {
  StateField,
  RangeSetBuilder,
  StateEffect,
  EditorSelection,
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
import {
  parseBlockMathContext,
  createBlockMathEditTransaction
} from './special-block-edit.js';
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
          tr.isUserEvent('block-math.edit') ||
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

const TABLE_ALIGN_LEFT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="15" y1="12" x2="3" y2="12"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_ALIGN_CENTER_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="19" y1="12" x2="5" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_ALIGN_RIGHT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="12" x2="9" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
const TABLE_GRID_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`;
const TABLE_TRASH_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

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
      const cellText = cell.map((node) => ('value' in node ? node.value : node.raw)).join('');
      if (cellText.trim()) {
        th.textContent = cellText;
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'cm-table-cell-placeholder';
        placeholder.textContent = ' ';
        th.appendChild(placeholder);
      }

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
        this.startCellEdit(view, th, -1, colIdx, cellText);
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
        const cellText = cell.map((node) => ('value' in node ? node.value : node.raw)).join('');
        if (cellText.trim()) {
          td.textContent = cellText;
        } else {
          const placeholder = document.createElement('span');
          placeholder.className = 'cm-table-cell-placeholder';
          placeholder.textContent = ' ';
          td.appendChild(placeholder);
        }

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
          this.startCellEdit(view, td, rowIdx, colIdx, cellText);
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
    colIndex: number,
    initialValue: string
  ): void {
    if (view.state.readOnly || cellEl.querySelector('.cm-table-cell-editor')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-table-cell-editor';
    input.value = initialValue.trim();

    cellEl.textContent = '';
    cellEl.appendChild(input);
    input.focus();
    input.select();

    const controller = createSubEditorController(view, () => {
      // 取消、只读切换和无变更退出都恢复展示；提交后由新投影显示新正文。
      if (cellEl.contains(input)) {
        cellEl.textContent = '';
        if (initialValue.trim()) {
          cellEl.textContent = initialValue;
        } else {
          const placeholder = document.createElement('span');
          placeholder.className = 'cm-table-cell-placeholder';
          placeholder.textContent = ' ';
          cellEl.appendChild(placeholder);
        }
      }
    });
    const { signal } = controller;

    let isComposing = false;
    input.addEventListener(
      'compositionstart',
      () => {
        isComposing = true;
      },
      { signal }
    );
    input.addEventListener(
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

      const newValue = input.value;
      if (newValue === initialValue.trim()) {
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

    input.addEventListener(
      'keydown',
      (e) => {
        if (!controller.isActive() || isComposing || e.isComposing) return;
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

    input.addEventListener(
      'blur',
      () => {
        if (controller.isActive() && !isComposing) {
          commit();
        }
      },
      { signal }
    );
  }

  public ignoreEvent(): boolean {
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
  setTimer?: (timer: ReturnType<typeof setTimeout> | null) => void
): void {
  copyBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) {
      copyBtn.dataset.copyState = 'error';
      copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Failed</span>`;
      return;
    }
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        copyBtn.dataset.copyState = 'success';
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `${CHECK_ICON_SVG}<span class="cm-code-copy-label">Copied!</span>`;
        const timer = setTimeout(() => {
          copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Copy</span>`;
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
    public readonly value: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockHeaderWidget &&
      other.from === this.from &&
      other.firstLineTo === this.firstLineTo &&
      other.language === this.language &&
      other.value === this.value
    );
  }

  public toDOM(view: EditorView): HTMLElement {
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
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.title = 'Copy code';
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Copy</span>`;

    container.appendChild(leftGroup);
    container.appendChild(copyBtn);

    bindClipboardCopy(copyBtn, () => this.value, (timer) => {
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = timer;
    });

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

export class CodeBlockWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly language: string | undefined,
    public readonly value: string
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
      other.value === this.value
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-code-block';

    const header = document.createElement('div');
    header.className = 'cm-code-header';

    const langBadge = document.createElement('span');
    langBadge.className = 'cm-code-language';
    langBadge.textContent = this.language || 'text';
    header.appendChild(langBadge);

    const isMermaid = this.language === 'mermaid';
    let toggleBtn: HTMLButtonElement | null = null;

    if (isMermaid) {
      toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'cm-mermaid-toggle';
      toggleBtn.textContent = 'Source';
      header.appendChild(toggleBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.title = 'Copy code';
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Copy</span>`;
    header.appendChild(copyBtn);
    container.appendChild(header);

    bindClipboardCopy(copyBtn, () => this.value, (timer) => {
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = timer;
    });

    let previewEl: HTMLElement | null = null;
    let control: EditorExtensionControl | undefined;
    if (isMermaid) {
      previewEl = document.createElement('div');
      previewEl.className = 'cm-mermaid-preview';
      const host = view.state.facet(extensionHostFacet);
      control = mountExtension(
        host,
        { type: 'code-fence', from: this.from, to: this.to, text: this.value, language: this.language },
        previewEl,
        this.value,
        () => {
          previewEl!.innerHTML = '';
          const previewPre = document.createElement('pre');
          previewPre.textContent = this.value;
          previewEl!.appendChild(previewPre);
          view.requestMeasure();
        },
        () => {
          view.requestMeasure();
        }
      );
      (previewEl as any).__nexusExtensionControl = control;
      container.appendChild(previewEl);
    }

    const pre = document.createElement('pre');
    pre.className = 'cm-code-body';
    const code = document.createElement('code');
    code.textContent = this.value;
    pre.appendChild(code);
    container.appendChild(pre);

    if (isMermaid && toggleBtn && previewEl) {
      let isShowingPreview = true;
      pre.style.display = 'none';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isShowingPreview = !isShowingPreview;
        if (isShowingPreview) {
          previewEl!.style.display = '';
          pre.style.display = 'none';
          toggleBtn!.textContent = 'Source';
        } else {
          previewEl!.style.display = 'none';
          pre.style.display = '';
          toggleBtn!.textContent = 'Preview';
        }
      });
    }

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

export class BlockMathWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

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
    if (dom.querySelector('.cm-block-math-editor')) return false;
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      view.requestMeasure();
      return true;
    }
    return false;
  }

  private control?: EditorExtensionControl;

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math';
    const host = view.state.facet(extensionHostFacet);

    const renderPreview = () => {
      container.innerHTML = '';
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
        }
      );
      (container as any).__nexusExtensionControl = this.control;
    };

    renderPreview();

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-block-math-editor')) return;

      if (this.control) {
        this.control.destroy();
        this.control = undefined;
        (container as any).__nexusExtensionControl = undefined;
      }

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-block-math-editor';
      textarea.value = this.formula;

      container.innerHTML = '';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        if (container.contains(textarea)) textarea.remove();
        renderPreview();
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
        const src = view.state.doc.toString();
        const parsed = parseMarkdown(src);
        let target: Extract<MarkdownBlockNode, { type: 'block-math' }> | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'block-math' && child.range.from === this.from) {
            target = child;
            return true;
          }
          return false;
        });
        if (target) {
          const ctx = parseBlockMathContext(src, target);
          const tx = createBlockMathEditTransaction(src, ctx, textarea.value);
          if (tx) {
            controller.close();
            view.dispatch({ changes: tx.changes, userEvent: tx.userEvent });
            return;
          }
        }
        controller.close();
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
/**
 * 构建最小 Visual surface 投影。
 * source 仍然是 EditorState.doc，视觉层只通过 decoration/widget 隐藏语法定界符。
 */
export function buildVisualProjection(
  source: string,
  selection: EditorSelection | null = null,
  isFocused: boolean = false,
  documentDirectory: string | null = null,
  locale: string = 'zh-CN'
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
      if (isRevealed) {
        const rightBracketIdx = inlineNode.raw.indexOf(']');
        if (rightBracketIdx !== -1) {
          const closeFrom = inlineNode.range.from + rightBracketIdx;
          const closeDelim = inlineNode.raw.slice(rightBracketIdx);
          ranges.push({
            from: inlineNode.range.from,
            to: inlineNode.range.from + 1,
            decoration: Decoration.replace({ widget: new DelimiterWidget('[', true) })
          });
          if (closeFrom < inlineNode.range.to) {
            ranges.push({
              from: closeFrom,
              to: inlineNode.range.to,
              decoration: Decoration.replace({ widget: new DelimiterWidget(closeDelim, true) })
            });
          }
          for (const child of inlineNode.children) {
            walkInline(child);
          }
        } else {
          for (const child of inlineNode.children) {
            walkInline(child);
          }
        }
      } else {
        const label = getInlineNodePlainText(inlineNode);
        ranges.push({
          from: inlineNode.range.from,
          to: inlineNode.range.to,
          decoration: Decoration.replace({
            widget: new LinkWidget(
              inlineNode.range.from,
              inlineNode.range.to,
              inlineNode.raw,
              label,
              inlineNode.safeHref,
              Boolean(inlineNode.isBlocked),
              inlineNode.title
            )
          })
        });
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
      ranges.push({
        from: inlineNode.range.from,
        to: inlineNode.range.to,
        decoration: Decoration.replace({
          widget: new InlineMathWidget(
            inlineNode.range.from,
            inlineNode.range.to,
            inlineNode.raw,
            inlineNode.formula
          )
        })
      });
    } else if (inlineNode.type === 'inline-code') {
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

      const isMermaid = blockNode.language === 'mermaid' && !isQuoteNested;
      if (isMermaid) {
        ranges.push({
          from: blockNode.range.from,
          to: blockWidgetDecorationEnd(blockNode.range, blockNode.raw),
          decoration: Decoration.replace({
            widget: new CodeBlockWidget(
              blockNode.range.from,
              blockNode.range.to,
              blockNode.raw,
              blockNode.language,
              blockNode.value
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
            blockNode.value
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

  function walkListItem(item: MarkdownListItem): void {
    const isRevealed = isNodeRevealed(item.range);
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
    } else {
      const firstLine = item.raw.split(/\r?\n/)[0] ?? '';
      const match = firstLine.match(/^([ \t]*)([-+*]|\d+[.)])/);
      if (match && match[2]) {
        const indentLen = match[1]?.length ?? 0;
        const from = item.range.from + indentLen;
        const to = from + match[2].length;
        // 列表标记独占行时保持可见，否则后续输入会落到文档开头
        const itemRevealed = isRevealed || isMarkerAtLineEnd(firstLine, indentLen + match[2].length);
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({
            widget: new DelimiterWidget(match[2], itemRevealed)
          })
        });
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

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (range.from <= range.to) {
      builder.add(range.from, range.to, range.decoration);
    }
  }
  return builder.finish();
}

/** Visual surface 的 source-aligned decoration field。 */
export const visualProjectionField = StateField.define<DecorationSet>({
  create(state) {
    const isFocused = state.field(visualFocusField, false);
    const docDir = state.field(documentDirectoryField, false);
    const locale = state.facet(editorLocaleFacet);
    return buildVisualProjection(state.doc.toString(), state.selection, isFocused, docDir, locale);
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

    if (
      transaction.docChanged ||
      focusChanged ||
      docDirChanged ||
      localeChanged ||
      readOnlyChanged ||
      selectionChanged ||
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
        locale
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
  subEditorLifecyclePlugin,
  hoveredCodeBlockField,
  codeBlockHoverPlugin
];
