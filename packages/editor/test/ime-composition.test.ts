// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  isEditorComposing,
  setEditorReadOnly
} from '../src/index.js';

describe('P1-04E IME Composition Protection Lifecycle', () => {
  it('tracks isEditorComposing state during compositionstart and compositionend', () => {
    const session = new MarkdownDocumentSession('Initial text');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-1',
      surfaceKind: 'visual',
      parent
    });

    expect(isEditorComposing(handle.view)).toBe(false);

    // Dispatch compositionstart event
    const compStartEvent = new CompositionEvent('compositionstart', { data: '' });
    handle.view.contentDOM.dispatchEvent(compStartEvent);

    expect(isEditorComposing(handle.view)).toBe(true);

    // Dispatch compositionend event
    const compEndEvent = new CompositionEvent('compositionend', { data: '你好' });
    handle.view.contentDOM.dispatchEvent(compEndEvent);

    expect(isEditorComposing(handle.view)).toBe(false);

    handle.destroy();
    parent.remove();
  });

  it('does NOT rebuild visual projection decorations during active composition', () => {
    const source = 'See | col 1 | col 2 |\n| --- | --- |\n| a | b |';
    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-2',
      surfaceKind: 'visual',
      parent
    });

    // Start composition
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(handle.view)).toBe(true);

    // During composition, an update happens
    const initialRev = session.getSnapshot().revision;
    // Typing during composition should not trigger full session dispatch per keystroke
    expect(session.getSnapshot().revision).toBe(initialRev);

    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '完成' }));
    expect(isEditorComposing(handle.view)).toBe(false);

    handle.destroy();
    parent.remove();
  });

  it('buffers IME keystrokes and commits composed text to session upon compositionend in exactly 1 revision and 1 undo step', () => {
    const session = new MarkdownDocumentSession('Prefix Suffix');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-commit-1',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // 1. User starts IME composition
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(handle.view)).toBe(true);

    // 2. User types pinyin intermediate text 'nihao '
    handle.view.dispatch({
      changes: { from: 7, to: 7, insert: 'nihao ' }
    });
    // Intermediate keystrokes must not commit to session snapshot
    expect(session.getSnapshot().source).toBe('Prefix Suffix');
    expect(session.getSnapshot().revision).toBe(initialRev);

    // 3. User selects Chinese candidate '你好 '
    handle.view.dispatch({
      changes: { from: 7, to: 13, insert: '你好 ' }
    });
    expect(session.getSnapshot().source).toBe('Prefix Suffix');
    expect(session.getSnapshot().revision).toBe(initialRev);

    // 4. Composition ends
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '你好 ' }));
    expect(isEditorComposing(handle.view)).toBe(false);

    // 5. Canonical session must now contain the committed Chinese text
    expect(session.getSnapshot().source).toBe('Prefix 你好 Suffix');
    // Exactly 1 revision increment
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    // 6. Exactly 1 undo step restores pre-composition state
    session.undo();
    expect(session.getSnapshot().source).toBe('Prefix Suffix');

    // 7. Redo restores composed text
    session.redo();
    expect(session.getSnapshot().source).toBe('Prefix 你好 Suffix');

    handle.destroy();
    parent.remove();
  });

  it('handles compositionend followed by candidate text insertion in subsequent transaction', () => {
    const session = new MarkdownDocumentSession('Base Text');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-commit-2',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // Composition starts
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));

    // Composition ends before doc change transaction
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '世界 ' }));

    // Transaction inserting text arrives
    handle.view.dispatch({
      changes: { from: 5, to: 5, insert: '世界 ' }
    });

    expect(session.getSnapshot().source).toBe('Base 世界 Text');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    session.undo();
    expect(session.getSnapshot().source).toBe('Base Text');

    handle.destroy();
    parent.remove();
  });

  it('handles multi-character selection replacement during IME composition', () => {
    const session = new MarkdownDocumentSession('Hello [ReplaceMe] World');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-sel',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;
    const from = 6;
    const to = 17; // '[ReplaceMe]'

    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));

    // Replaces selection with intermediate pinyin
    handle.view.dispatch({
      changes: { from, to, insert: 'ceshi' }
    });
    expect(session.getSnapshot().revision).toBe(initialRev);

    // End composition with Chinese candidate '测试'
    handle.view.dispatch({
      changes: { from, to: from + 5, insert: '测试' }
    });
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '测试' }));

    expect(session.getSnapshot().source).toBe('Hello 测试 World');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    session.undo();
    expect(session.getSnapshot().source).toBe('Hello [ReplaceMe] World');

    handle.destroy();
    parent.remove();
  });

  it('aborts active IME composition and discards buffered changes if surface becomes readOnly', () => {
    const session = new MarkdownDocumentSession('Locked Content');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-ro',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 7, to: 7, insert: 'pinyin' }
    });

    // Make view readOnly during composition
    setEditorReadOnly(handle.view, true);

    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '拼音' }));

    // Should not corrupt or commit to readOnly session
    expect(session.getSnapshot().revision).toBe(initialRev);

    handle.destroy();
    parent.remove();
  });

  it('aborts composition commit and syncs to canonical session if external revision changes during IME', () => {
    const session = new MarkdownDocumentSession('Initial Doc');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-ext',
      surfaceKind: 'visual',
      parent
    });

    // 1. User starts IME composition
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 8, to: 8, insert: 'ext' }
    });

    // 2. External surface or collaborator edits document in the background
    session.dispatch(
      {
        changes: [{ from: 0, to: 7, insert: 'External' }],
        userEvent: 'remote.sync'
      },
      'remote-surface'
    );
    expect(session.getSnapshot().source).toBe('External Doc');

    // 3. User finishes composition on divergent local state
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: 'ext' }));

    // Must not clobber remote edit or corrupt session
    expect(session.getSnapshot().source).toContain('External');

    handle.destroy();
    parent.remove();
  });

  it('restores view.doc to session snapshot upon readOnly abort, purges pinyin, and prevents offset corruption on resume', () => {
    const session = new MarkdownDocumentSession('Hello World');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-ro-strict',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // 1. Start composition and type pinyin
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 6, to: 6, insert: 'shijie' }
    });
    expect(handle.view.state.doc.toString()).toBe('Hello shijieWorld');

    // 2. Dynamically set readOnly = true
    setEditorReadOnly(handle.view, true);

    // After readOnly abort, view.doc must be fully restored to canonical session snapshot
    expect(handle.view.state.doc.toString()).toBe(session.getSnapshot().source);
    expect(handle.view.state.doc.toString()).toBe('Hello World');
    expect(handle.view.state.doc.toString()).not.toContain('shijie');
    expect(session.getSnapshot().revision).toBe(initialRev);

    // Compositionend arrives after abort
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '世界' }));
    expect(handle.view.state.doc.toString()).toBe('Hello World');
    expect(session.getSnapshot().source).toBe('Hello World');
    expect(session.getSnapshot().revision).toBe(initialRev);

    // 3. Resume editing: set readOnly = false
    setEditorReadOnly(handle.view, false);
    expect(handle.view.state.readOnly).toBe(false);

    // 4. Next normal typing at position 6
    handle.view.dispatch({
      changes: { from: 6, to: 6, insert: 'Earth ' }
    });

    expect(handle.view.state.doc.toString()).toBe('Hello Earth World');
    expect(session.getSnapshot().source).toBe('Hello Earth World');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    handle.destroy();
    parent.remove();
  });

  it('purges local pinyin/candidate text completely when external sync arrives during composition', () => {
    const session = new MarkdownDocumentSession('Initial Base Doc');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-ext-purge',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // 1. Local composition starts and types pinyin
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 8, to: 8, insert: 'pinyin' }
    });
    expect(handle.view.state.doc.toString()).toBe('Initial pinyinBase Doc');

    // 2. Remote surface updates document
    session.dispatch(
      {
        changes: [{ from: 0, to: 7, insert: 'Updated' }],
        userEvent: 'remote.sync'
      },
      'remote-surface-2'
    );
    expect(session.getSnapshot().source).toBe('Updated Base Doc');

    // Local view.doc must be resynced to canonical source and pinyin completely purged
    expect(handle.view.state.doc.toString()).toBe('Updated Base Doc');
    expect(handle.view.state.doc.toString()).not.toContain('pinyin');

    // 3. Late compositionend event fires on local view
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '拼音' }));

    // Must not append dirty text, must not increase revision beyond remote edit
    expect(handle.view.state.doc.toString()).toBe('Updated Base Doc');
    expect(session.getSnapshot().source).toBe('Updated Base Doc');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    // Exactly 1 undo step for remote edit
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe('Initial Base Doc');
    expect(handle.view.state.doc.toString()).toBe('Initial Base Doc');

    handle.destroy();
    parent.remove();
  });

  it('supports CRLF, CJK, Emoji, and multi-line selection replacement in normal composition', () => {
    const initialSource = 'Title 🎉\r\nLine 2: [ReplaceMe] 🚀\r\nEnd';
    const session = new MarkdownDocumentSession(initialSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-crlf-emoji',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;
    const from = initialSource.indexOf('[ReplaceMe]');
    const to = from + '[ReplaceMe]'.length;

    // Start composition on selection
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));

    // User types pinyin replacing selection
    handle.view.dispatch({
      changes: { from, to, insert: 'ceshi' }
    });
    expect(session.getSnapshot().revision).toBe(initialRev);

    // Composition ends with CJK candidate '测试'
    handle.view.dispatch({
      changes: { from, to: from + 5, insert: '测试' }
    });
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '测试' }));

    const expectedSource = 'Title 🎉\r\nLine 2: 测试 🚀\r\nEnd';
    expect(handle.view.state.doc.toString()).toBe(expectedSource);
    expect(session.getSnapshot().source).toBe(expectedSource);
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    // Exactly 1 undo step restores original CRLF & Emoji source
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe(initialSource);
    expect(handle.view.state.doc.toString()).toBe(initialSource);

    // Redo restores
    session.redo();
    expect(session.getSnapshot().source).toBe(expectedSource);
    expect(handle.view.state.doc.toString()).toBe(expectedSource);

    handle.destroy();
    parent.remove();
  });

  it('external session sync during composition immediately resets isEditorComposing to false even without compositionend', () => {
    const session = new MarkdownDocumentSession('Original Content');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-sync-immediate',
      surfaceKind: 'visual',
      parent
    });

    // 1. Surface starts composition
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 9, to: 9, insert: 'pinyin' }
    });
    expect(isEditorComposing(handle.view)).toBe(true);
    expect(handle.view.state.doc.toString()).toBe('Original pinyinContent');

    // 2. External session sync arrives from collaborator
    session.dispatch(
      {
        changes: [{ from: 0, to: 8, insert: 'Canonical' }],
        userEvent: 'remote.sync'
      },
      'remote-collaborator'
    );

    // 3. Immediately after external sync (WITHOUT any compositionend event from browser):
    // - isEditorComposing(view) must be false
    expect(isEditorComposing(handle.view)).toBe(false);
    // - view.doc must equal session canonical source
    expect(handle.view.state.doc.toString()).toBe('Canonical Content');
    expect(handle.view.state.doc.toString()).toBe(session.getSnapshot().source);

    // - Uncommitted pinyin never enters session revision or undo
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe('Original Content');
    expect(session.canUndo).toBe(false);

    handle.destroy();
    parent.remove();
  });

  it('readOnly transition aborts composition and restores non-collapsed canonical selection atomically', () => {
    const initialSource = 'Hello [Target] World';
    // Multi-character non-collapsed selection [6, 14] covering '[Target]'
    const initialSelection = { anchor: 6, head: 14 };
    const session = new MarkdownDocumentSession(initialSource, initialSelection);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'visual-ime-ro-selection',
      surfaceKind: 'visual',
      parent
    });

    // Verify initial selection on view
    expect(handle.view.state.selection.main.anchor).toBe(6);
    expect(handle.view.state.selection.main.head).toBe(14);

    // Start composition and replace selection with pinyin
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 6, to: 14, insert: 'shijie' },
      selection: { anchor: 12, head: 12 }
    });
    expect(handle.view.state.doc.toString()).toBe('Hello shijie World');

    // Dynamically toggle readOnly = true
    setEditorReadOnly(handle.view, true);

    // Atomic recovery must restore canonical source AND exact non-collapsed canonical selection
    expect(handle.view.state.doc.toString()).toBe(initialSource);
    expect(handle.view.state.selection.main.anchor).toBe(initialSelection.anchor);
    expect(handle.view.state.selection.main.head).toBe(initialSelection.head);
    expect(isEditorComposing(handle.view)).toBe(false);

    handle.destroy();
    parent.remove();
  });

  it('selection-only session sync during active composition does NOT abort composition', () => {
    const session = new MarkdownDocumentSession('Prefix Suffix');
    const parent1 = document.createElement('div');
    const parent2 = document.createElement('div');
    document.body.appendChild(parent1);
    document.body.appendChild(parent2);

    const surfaceA = createSessionEditorView({
      session,
      surfaceId: 'surface-a',
      surfaceKind: 'visual',
      parent: parent1
    });

    const surfaceB = createSessionEditorView({
      session,
      surfaceId: 'surface-b',
      surfaceKind: 'visual',
      parent: parent2
    });

    const initialRev = session.getSnapshot().revision;

    // 1. Surface A starts composition
    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(surfaceA.view)).toBe(true);

    // 2. Surface A types intermediate text
    surfaceA.view.dispatch({
      changes: { from: 7, to: 7, insert: 'nihao' }
    });

    // 3. Another surface or external caller changes selection only (e.g. cursor moves on surface B)
    session.setSelection({ anchor: 2, head: 2 }, 'surface-b');

    // 4. Composition on Surface A must NOT be aborted by selection-only sync!
    expect(isEditorComposing(surfaceA.view)).toBe(true);
    expect(surfaceA.view.state.doc.toString()).toBe('Prefix nihaoSuffix');

    // 5. Normal compositionend on Surface A should commit cleanly
    surfaceA.view.dispatch({
      changes: { from: 7, to: 12, insert: '你好' }
    });
    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
    expect(isEditorComposing(surfaceA.view)).toBe(false);

    // Canonical source updated with composed text
    expect(session.getSnapshot().source).toBe('Prefix 你好Suffix');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    surfaceA.destroy();
    surfaceB.destroy();
    parent1.remove();
    parent2.remove();
  });

  it('external source modification during active composition immediately clears composing field, restores canonical doc, and blocks late compositionend commit', () => {
    const session = new MarkdownDocumentSession('Hello World');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'surface-composing',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // 1. Surface starts composition
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(handle.view)).toBe(true);

    // 2. Types intermediate uncommitted text
    handle.view.dispatch({
      changes: { from: 6, to: 6, insert: 'pinyin ' }
    });
    expect(handle.view.state.doc.toString()).toBe('Hello pinyin World');

    // 3. External collaborator modifies source
    session.dispatch(
      {
        changes: [{ from: 0, to: 11, insert: 'Collaborator Text' }],
        selection: { anchor: 17, head: 17 },
        userEvent: 'remote.sync'
      },
      'remote-collaborator'
    );

    // 4. Immediately after external source modification:
    // - isEditorComposing(view) must be false
    expect(isEditorComposing(handle.view)).toBe(false);
    // - view.doc must equal session canonical source
    expect(handle.view.state.doc.toString()).toBe('Collaborator Text');
    expect(handle.view.state.selection.main.head).toBe(17);
    expect(session.getSnapshot().revision).toBe(initialRev + 1);

    // 5. Late compositionend arrives from browser with stale candidate text
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '迟到中文' }));

    // Late compositionend must NOT overwrite or commit to session
    expect(session.getSnapshot().source).toBe('Collaborator Text');
    expect(session.getSnapshot().revision).toBe(initialRev + 1);
    expect(handle.view.state.doc.toString()).toBe('Collaborator Text');
    expect(isEditorComposing(handle.view)).toBe(false);

    // Exactly 1 undo step restores pre-remote source, no corrupt intermediate state in history
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.getSnapshot().source).toBe('Hello World');
    expect(session.canUndo).toBe(false);

    handle.destroy();
    parent.remove();
  });

  it('queues external selection-only sync during active composition and applies latest selection on compositionend', async () => {
    const session = new MarkdownDocumentSession('Prefix Suffix');
    const parent1 = document.createElement('div');
    const parent2 = document.createElement('div');
    document.body.appendChild(parent1);
    document.body.appendChild(parent2);

    const surfaceA = createSessionEditorView({
      session,
      surfaceId: 'surface-ime-sel-a',
      surfaceKind: 'visual',
      parent: parent1
    });

    const surfaceB = createSessionEditorView({
      session,
      surfaceId: 'surface-ime-sel-b',
      surfaceKind: 'visual',
      parent: parent2
    });

    // 1. Surface A starts composition
    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(isEditorComposing(surfaceA.view)).toBe(true);

    // 2. Surface A types intermediate text from pos 7
    surfaceA.view.dispatch({
      changes: { from: 7, to: 7, insert: 'pinyin' },
      selection: { anchor: 13, head: 13 }
    });
    expect(surfaceA.view.state.selection.main.head).toBe(13);

    // 3. Surface B changes selection only to position 2
    session.setSelection({ anchor: 2, head: 2 }, 'surface-ime-sel-b');

    // 4. Surface A must completely ignore external selection during composition
    // Local cursor must remain at 13, composition must remain active
    expect(isEditorComposing(surfaceA.view)).toBe(true);
    expect(surfaceA.view.state.selection.main.head).toBe(13);
    expect(surfaceA.view.state.doc.toString()).toBe('Prefix pinyinSuffix');

    // 5. Surface A completes composition
    surfaceA.view.dispatch({
      changes: { from: 7, to: 13, insert: '你好' }
    });
    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
    expect(isEditorComposing(surfaceA.view)).toBe(false);

    // Wait for microtask queue
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Session committed
    expect(session.getSnapshot().source).toBe('Prefix 你好Suffix');
    // Queued selection at 2 should now be applied smoothly
    expect(surfaceA.view.state.selection.main.head).toBe(2);

    surfaceA.destroy();
    surfaceB.destroy();
    parent1.remove();
    parent2.remove();
  });

  it('maps a queued selection after the composition inserts text before it', async () => {
    const session = new MarkdownDocumentSession('Prefix Suffix');
    const parent1 = document.createElement('div');
    const parent2 = document.createElement('div');
    document.body.appendChild(parent1);
    document.body.appendChild(parent2);

    const surfaceA = createSessionEditorView({
      session,
      surfaceId: 'surface-ime-map-a',
      surfaceKind: 'visual',
      parent: parent1
    });
    const surfaceB = createSessionEditorView({
      session,
      surfaceId: 'surface-ime-map-b',
      surfaceKind: 'visual',
      parent: parent2
    });

    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    surfaceA.view.dispatch({
      changes: { from: 7, to: 7, insert: 'pinyin' },
      selection: { anchor: 13, head: 13 }
    });

    // Canonical position 13 is after the composition insertion point and must map after the edit.
    session.setSelection({ anchor: 13, head: 13 }, 'surface-ime-map-b');
    surfaceA.view.dispatch({ changes: { from: 7, to: 13, insert: '你好' } });
    surfaceA.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(session.getSnapshot().source).toBe('Prefix 你好Suffix');
    expect(surfaceA.view.state.selection.main.head).toBe(15);

    surfaceA.destroy();
    surfaceB.destroy();
    parent1.remove();
    parent2.remove();
  });

  it('blocks delayed commit when surface is destroyed during active composition', () => {
    const session = new MarkdownDocumentSession('Clean Document');
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'surface-destroy-ime',
      surfaceKind: 'visual',
      parent
    });

    const initialRev = session.getSnapshot().revision;

    // Start composition and insert pinyin
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    handle.view.dispatch({
      changes: { from: 5, to: 5, insert: 'pinyin' }
    });
    expect(isEditorComposing(handle.view)).toBe(true);

    // Destroy surface while still composing
    handle.destroy();

    // Browser fires delayed compositionend on detached element
    handle.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '拼音' }));

    // Session must remain untouched
    expect(session.getSnapshot().source).toBe('Clean Document');
    expect(session.getSnapshot().revision).toBe(initialRev);

    parent.remove();
  });
});
