import { EditorState, Compartment, Facet, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
export { EditorView } from '@codemirror/view';
export { EditorState } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { getCodeLanguage } from './code-highlight.js';

import { editorKeybindings } from './keymaps.js';
import { markdownCompletionSource } from './completions.js';
import { markdownMarkersField } from './markdown-markers.js';
import { getEditorTheme } from './theme.js';
import { getSelectionInfo } from './selection.js';
import type { CreateSourceEditorOptions, SourceEditorConfig } from './types.js';
import { extensionHostFacet } from './extensions.js';

export const readOnlyCompartment = new Compartment();
export const editableCompartment = new Compartment();
export const themeCompartment = new Compartment();
export const editorLocaleCompartment = new Compartment();

export const editorLocaleFacet = Facet.define<string, string>({
  combine: (values) => values[0] || 'zh-CN'
});

/**
 * Builds the standard extensions array for Nexus Markdown Source Mode.
 */
export function getSourceEditorExtensions(config: SourceEditorConfig = {}): Extension[] {
  const isReadOnly = Boolean(config.readOnly);

  // `lineWrapping` 让超长行软换行，从而不出现横向滚动条。
  //
  // 它与 `lineNumbers()` 配合正好是「换行显示 + 续行不显示行号」：
  // `lineNumbers()` 只给**逻辑行起点**标号，软换行出来的续行本来就不带行号 ——
  // 所以不需要额外做「隐藏续行行号」的处理，两件事是一件事。
  const extensions: Extension[] = [lineNumbers(), EditorView.lineWrapping];

  if (config.includeHistory !== false) {
    extensions.push(history());
  }

  extensions.push(

    search({ top: true }),

    markdown({
      codeLanguages: getCodeLanguage
    }),

    

    themeCompartment.of(getEditorTheme()),

    autocompletion({
      override: [markdownCompletionSource]
    }),

    markdownMarkersField,

    readOnlyCompartment.of(EditorState.readOnly.of(isReadOnly)),
    editableCompartment.of(EditorView.editable.of(!isReadOnly)),

    ...(config.extensionHost ? [extensionHostFacet.of(config.extensionHost)] : []),

    keymap.of(config.keybindings ?? editorKeybindings),

    EditorView.updateListener.of((update) => {
      if (update.docChanged && config.onChange) {
        config.onChange(update.state.doc.toString());
      }
      if ((update.selectionSet || update.docChanged) && config.onSelectionChange) {
        config.onSelectionChange(getSelectionInfo(update.state));
      }
    })
  );

  return extensions;
}

/**
 * Creates an EditorState configured for Markdown Source Mode.
 */
export function createSourceEditorState(config: SourceEditorConfig = {}): EditorState {
  return EditorState.create({
    doc: config.doc ?? '',
    extensions: getSourceEditorExtensions(config)
  });
}

/**
 * Creates and mounts a CodeMirror 6 EditorView for Source Mode.
 */
export function createSourceEditorView(options: CreateSourceEditorOptions): EditorView {
  const state = createSourceEditorState(options);

  const view = new EditorView({
    state,
    parent: options.parent
  });

  // Emit initial selection status
  if (options.onSelectionChange) {
    options.onSelectionChange(getSelectionInfo(view.state));
  }

  return view;
}

/**
 * Reconfigures the read-only state of an existing EditorView.
 */
export function setEditorReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({
    effects: [
      readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      editableCompartment.reconfigure(EditorView.editable.of(!readOnly))
    ]
  });
}

/**
 * Reconfigures the theme of an existing EditorView.
 */
export function setEditorThemeConfig(view: EditorView, _theme: 'light' | 'dark'): void {
  view.dispatch({
    effects: [
      themeCompartment.reconfigure(getEditorTheme())
    ]
  });
}

/**
 * Reconfigures the locale of an existing EditorView.
 */
export function setEditorLocale(view: EditorView, locale: string): void {
  view.dispatch({
    effects: [
      editorLocaleCompartment.reconfigure(editorLocaleFacet.of(locale))
    ]
  });
}
