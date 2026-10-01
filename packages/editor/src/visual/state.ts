import { StateField, StateEffect, Compartment, Facet } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin
} from '@codemirror/view';
import { getRowCellRanges } from '@nexus/markdown';
import { findTableAtPosition, splitTableLines } from '../table-edit.js';

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

/**
 * 工作区里一个可能被 `![[…]]` 命中的资源。
 *
 * 三份都是宿主算好的成品 —— 编辑器不知道工作区根在哪、也不该知道，与
 * `documentDirectoryField` 同一条分层纪律。`relative` 是**工作区根相对**且已转正斜杠：
 * Obsidian 的嵌入地址就写这个形状，直接拿它当键。
 */
export interface WorkspaceAssetEntry {
  /** 绝对路径，拼 `nexus-asset://` 用。 */
  readonly path: string;
  /** 工作区根相对路径，正斜杠。 */
  readonly relative: string;
  /** 文件名。按名兜底时匹配它。 */
  readonly name: string;
}

/** 空清单：`create()` 与默认参数共用一个，不每次 new。 */
export const EMPTY_WORKSPACE_ASSETS: readonly WorkspaceAssetEntry[] = Object.freeze([]);

export const setWorkspaceAssetsEffect = StateEffect.define<readonly WorkspaceAssetEntry[]>();

/**
 * 工作区资源清单。
 *
 * 存在的理由只有一个：**嵌入的回退链要问「这个候选路径存在吗」**，而投影是同步的、
 * 不能回头去问宿主。宿主把索引转成清单递进来，解析就退化成纯字符串比较。
 * 索引刷新后由 `setWorkspaceAssets` 重新注入；数组身份不变时投影不重算。
 */
export const workspaceAssetsField = StateField.define<readonly WorkspaceAssetEntry[]>({
  create() {
    return EMPTY_WORKSPACE_ASSETS;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWorkspaceAssetsEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export function setWorkspaceAssets(
  view: EditorView,
  assets: readonly WorkspaceAssetEntry[]
): void {
  view.dispatch({ effects: setWorkspaceAssetsEffect.of(assets) });
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

/** 空 pin 表：让 `buildVisualProjection` 的默认参数不用每次 new 一个。 */
export const EMPTY_MERMAID_PINS: ReadonlyMap<number, MermaidPreviewPin> = new Map();

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

