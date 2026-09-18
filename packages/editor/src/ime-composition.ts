import { StateField, StateEffect, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  sessionSyncAnnotation,
  sessionDocSyncAnnotation,
  sessionSelectionSyncAnnotation
} from './document-session.js';

/** 设置 IME composition 状态的 StateEffect */
export const setComposingEffect = StateEffect.define<boolean>();

/** 跟踪当前 EditorState 是否处于 IME composition 过程中的 StateField */
export const isComposingField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    if (
      tr.docChanged &&
      (tr.annotation(sessionDocSyncAnnotation) !== undefined ||
        (tr.annotation(sessionSyncAnnotation) !== undefined &&
          tr.annotation(sessionSelectionSyncAnnotation) === undefined))
    ) {
      return false;
    }
    if (!tr.startState.readOnly && tr.state.readOnly) {
      return false;
    }
    for (const effect of tr.effects) {
      if (effect.is(setComposingEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

/** 判断当前视图或状态是否处于输入法组合态 */
export function isEditorComposing(target: EditorView | { state: EditorState } | EditorState): boolean {
  const state = target instanceof EditorState ? target : 'state' in target ? target.state : undefined;
  if (state) {
    const fieldVal = state.field(isComposingField, false);
    if (fieldVal !== undefined) {
      return fieldVal;
    }
  }
  if ('composing' in target && typeof target.composing === 'boolean') {
    return target.composing;
  }
  return false;
}

/** 创建监听 IME 事件并维护组合状态的 CodeMirror Extension */
export function createImeCompositionExtension(): Extension {
  return [
    isComposingField,
    EditorView.domEventHandlers({
      compositionstart(_event, view) {
        view.dispatch({ effects: setComposingEffect.of(true) });
      },
      compositionend(_event, view) {
        view.dispatch({ effects: setComposingEffect.of(false) });
      }
    })
  ];
}
