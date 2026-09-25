import { StateField, type Extension } from '@codemirror/state';
import {
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view';
import { isEditorComposing, setComposingEffect } from '../ime-composition.js';
import { editorLocaleFacet } from '../source-editor.js';
import { subEditorLifecyclePlugin } from './sub-editor.js';
import {
  DEFAULT_MERMAID_PREVIEW_SETTINGS,
  documentDirectoryField,
  hoveredCodeBlockField,
  mermaidPreviewCompartment,
  mermaidPreviewPinField,
  mermaidPreviewSettingsFacet,
  setHoveredCodeBlockEffect,
  tableTargetField,
  visualFocusField,
  visualFocusPlugin
} from './state.js';
import { buildVisualProjection } from './projection.js';

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
