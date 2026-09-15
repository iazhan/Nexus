import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, keymap } from '@codemirror/view';
export { EditorView } from '@codemirror/view';
export { EditorState } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';

import { editorKeybindings } from './keymaps.js';
import { markdownCompletionSource } from './completions.js';
import { markdownMarkersField } from './markdown-markers.js';
import { editorBaseTheme, editorSyntaxHighlighting } from './theme.js';
import { getSelectionInfo } from './selection.js';
import type { CreateSourceEditorOptions, SourceEditorConfig } from './types.js';

export const readOnlyCompartment = new Compartment();
export const editableCompartment = new Compartment();

/**
 * Builds the standard extensions array for Nexus Markdown Source Mode.
 */
export function getSourceEditorExtensions(config: SourceEditorConfig = {}): Extension[] {
  const isReadOnly = Boolean(config.readOnly);

  const extensions: Extension[] = [lineNumbers()];

  if (config.includeHistory !== false) {
    extensions.push(history());
  }

  extensions.push(

    search({ top: true }),

    markdown(),

    editorSyntaxHighlighting,

    editorBaseTheme,

    autocompletion({
      override: [markdownCompletionSource]
    }),

    markdownMarkersField,

    readOnlyCompartment.of(EditorState.readOnly.of(isReadOnly)),
    editableCompartment.of(EditorView.editable.of(!isReadOnly)),

    keymap.of(editorKeybindings),

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
