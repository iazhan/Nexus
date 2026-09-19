import { type KeyBinding } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { completionKeymap } from '@codemirror/autocomplete';

export const editorKeybindings: KeyBinding[] = [
  ...defaultKeymap,
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-h', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-Shift-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
];

export const visualEditorKeybindings: KeyBinding[] = [
  ...defaultKeymap.filter((b) => b.key !== 'Enter' && b.key !== 'Backspace'),
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-h', run: openSearchPanel, scope: 'editor' },
  { key: 'Mod-Shift-f', run: openSearchPanel, scope: 'editor' },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor' }
];

export { openSearchPanel, closeSearchPanel };
