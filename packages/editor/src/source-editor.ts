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
import { createMarkdownCompletionSource } from './completions.js';
import { markdownMarkersField, blockGapField } from './markdown-markers.js';
import { getEditorTheme } from './theme.js';
import { getSelectionInfo } from './selection.js';
import type { CreateSourceEditorOptions, SourceEditorConfig } from './types.js';
import { extensionHostFacet } from './extensions.js';
import { createTypewriterExtension } from './typewriter.js';
import { vimCompartment } from './vim.js';

export const readOnlyCompartment = new Compartment();
export const editableCompartment = new Compartment();
export const themeCompartment = new Compartment();
export const editorLocaleCompartment = new Compartment();
export const lineNumbersCompartment = new Compartment();
/**
 * 拼写检查。**缺省是关**（CodeMirror 自己在 `contentDOM` 上写死 `spellcheck="false"`），
 * 打开就是把那条属性覆盖成 `true` —— 它不是「加一个扩展」，是改一个 DOM 属性。
 */
export const spellCheckCompartment = new Compartment();
/**
 * 打字机模式。与 `lineNumbers` 不同，它**没有构造参数**：`ViewPlugin` 不能在建 state 时
 * 就拿到 view，而且「跟随光标」这件事只在有光标之后才有意义。所以一律靠 `setEditorTypewriter`
 * 装上，构造时恒为空。
 */
export const typewriterCompartment = new Compartment();

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
  //
  // 行号槽走 Compartment：设置里能关掉它。缺省视为开（`config.lineNumbers !== false`），
  // 因为「关掉行号」是这个设置项带来的新可能，不是新的默认。
  const extensions: Extension[] = [
    lineNumbersCompartment.of(config.lineNumbers === false ? [] : lineNumbers()),
    EditorView.lineWrapping
  ];

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
      override: [createMarkdownCompletionSource(config.slashCommands)]
    }),

    markdownMarkersField,
    blockGapField,

    readOnlyCompartment.of(EditorState.readOnly.of(isReadOnly)),
    editableCompartment.of(EditorView.editable.of(!isReadOnly)),

    // 拼写检查走 `contentAttributes` 覆盖 CM 写死的 `spellcheck="false"`。关的时候送空扩展，
    // 而不是送 `spellcheck="false"` —— 后者会把 CM 自己那份默认值抄一遍，将来 CM 改了默认
    // 我们这里还是旧的。
    spellCheckCompartment.of(
      config.spellCheck ? EditorView.contentAttributes.of({ spellcheck: 'true' }) : []
    ),
    // 打字机模式与 vim 都在构造时留空，等 `setEditorTypewriter` / `applyEditorVim` 装上。
    typewriterCompartment.of([]),
    vimCompartment.of([]),

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

/**
 * Reconfigures the line-number gutter of an existing EditorView.
 *
 * 关掉时送空扩展而不是别的「隐藏样式」：`lineNumbers()` 自己会建一个 gutter DOM 与一块宽度，
 * 只把它藏起来的话那截宽度还在，正文会与左边框之间空一条 —— 看起来像没生效。
 */
export function setEditorLineNumbers(view: EditorView, visible: boolean): void {
  view.dispatch({
    effects: [lineNumbersCompartment.reconfigure(visible ? lineNumbers() : [])]
  });
}

/**
 * 拼写检查。与 `setEditorLineNumbers` 同形 —— 同样是一个 compartment，同样关的时候送空扩展。
 *
 * 浏览器在 `contenteditable` 上做拼写检查，所以这条只影响**渲染进程的输入元素**：它不改
 * 文档内容、不联网、也不经过任何 IPC（Chromium 的拼写检查在本地词典里做）。
 */
export function setEditorSpellCheck(view: EditorView, enabled: boolean): void {
  view.dispatch({
    effects: [
      spellCheckCompartment.reconfigure(
        enabled ? EditorView.contentAttributes.of({ spellcheck: 'true' }) : []
      )
    ]
  });
}

/** 打字机模式。装/卸的是同一个 `ViewPlugin`，没有「部分生效」的中间态。 */
export function setEditorTypewriter(view: EditorView, enabled: boolean): void {
  view.dispatch({
    effects: [typewriterCompartment.reconfigure(enabled ? createTypewriterExtension() : [])]
  });
}
