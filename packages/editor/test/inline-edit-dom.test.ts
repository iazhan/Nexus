// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  type ImageSourceResolver
} from '../src/index.js';

describe('P1-04D Real DOM Inline Edit & Popover Integration', () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    return () => {
      document.body.removeChild(parent);
    };
  });

  it('Visual Surface renders link, image, math, code, and wikilink widgets; Source Surface does not', () => {
    const source = 'See [Nexus](https://nexus.dev), ![Logo](./logo.png), $E=mc^2$, `code`, and [[WikiPage]].';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'test-visual-widgets',
      surfaceKind: 'visual'
    });

    const linkWidgets = visualHandle.view.dom.querySelectorAll('.cm-visual-link');
    const imgWidgets = visualHandle.view.dom.querySelectorAll('.cm-visual-image');
    const mathWidgets = visualHandle.view.dom.querySelectorAll('.cm-visual-inline-math');
    const codeWidgets = visualHandle.view.dom.querySelectorAll('.cm-visual-inline-code');
    const wikiWidgets = visualHandle.view.dom.querySelectorAll('.cm-visual-wikilink');

    expect(linkWidgets.length).toBe(1);
    expect(imgWidgets.length).toBe(1);
    expect(mathWidgets.length).toBe(1);
    expect(codeWidgets.length).toBe(1);
    expect(wikiWidgets.length).toBe(1);

    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);
    const sourceHandle = createSessionEditorView({
      parent: sourceParent,
      session,
      surfaceId: 'test-source-widgets',
      surfaceKind: 'source'
    });

    expect(sourceHandle.view.dom.querySelectorAll('.cm-visual-link').length).toBe(0);
    expect(sourceHandle.view.dom.querySelectorAll('.cm-visual-image').length).toBe(0);
    expect(sourceHandle.view.dom.querySelectorAll('.cm-visual-inline-math').length).toBe(0);
    expect(sourceHandle.view.dom.querySelectorAll('.cm-visual-inline-code').length).toBe(0);
    expect(sourceHandle.view.dom.querySelectorAll('.cm-visual-wikilink').length).toBe(0);

    visualHandle.destroy();
    sourceHandle.destroy();
    document.body.removeChild(sourceParent);
  });

  it('safely renders blocked link and image widgets without setting dangerous DOM attributes', () => {
    const source =
      '[JS Link](javascript:alert(1))\n' +
      '[VBS Link](vbscript:msgbox(1))\n' +
      '[Data Link](data:text/html,<script>alert(1)</script>)\n' +
      '![JS Img](javascript:alert(2))\n' +
      '![Data Img](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)';

    const session = new MarkdownDocumentSession(source);
    const handle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-security-projection',
      surfaceKind: 'visual'
    });

    const links = handle.view.dom.querySelectorAll('.cm-visual-link');
    expect(links.length).toBe(3);
    for (const link of links) {
      expect(link.classList.contains('cm-visual-link-blocked')).toBe(true);
      expect(link.getAttribute('aria-disabled')).toBe('true');
      const href = link.getAttribute('href');
      expect(href === null || href === '' || href === '#').toBe(true);
    }

    const images = handle.view.dom.querySelectorAll('.cm-visual-image');
    expect(images.length).toBe(2);
    for (const imgContainer of images) {
      expect(imgContainer.classList.contains('cm-visual-image-blocked')).toBe(true);
      const imgEl = imgContainer.querySelector('img');
      if (imgEl) {
        const src = imgEl.getAttribute('src');
        expect(src === null || src === '' || !src.startsWith('javascript:')).toBe(true);
      }
    }

    handle.destroy();
  });

  it('keeps Popover open and displays error when invalid URL is submitted, without changing source', () => {
    const source = 'Check [Doc](https://nexus.dev) out.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-invalid-url-test',
      surfaceKind: 'visual'
    });

    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();

    const destInput = popover.querySelector('.cm-link-dest-input') as HTMLInputElement;
    destInput.value = 'javascript:alert(1)';
    destInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    // Popover MUST remain open
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();
    const errorEl = popover.querySelector('.cm-inline-edit-error') as HTMLElement;
    expect(errorEl.textContent).toContain('Blocked');

    // Source, revision, history must NOT change
    expect(session.getSnapshot().source).toBe('Check [Doc](https://nexus.dev) out.');
    expect(session.getSnapshot().revision).toBe(0);
    expect(session.canUndo).toBe(false);

    // Now enter valid URL and submit
    destInput.value = 'https://nexus.dev/documentation';
    destInput.dispatchEvent(new Event('input', { bubbles: true }));
    saveBtn.click();

    // Now it should close and update
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('Check [Doc](https://nexus.dev/documentation) out.');
    expect(session.getSnapshot().revision).toBe(1);

    visualHandle.destroy();
  });

  it('clicking Save without modifying values cleanly closes Popover without error or revision increment', () => {
    const source = 'Check [Doc](https://nexus.dev) out.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-unchanged-test',
      surfaceKind: 'visual'
    });

    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    // Closes cleanly
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().revision).toBe(0);
    expect(session.getSnapshot().source).toBe(source);

    visualHandle.destroy();
  });

  it('handles async ImageSourceResolver safely against popover close and race conditions', async () => {
    const source = '![Placeholder](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveFirst: (url: string) => void;
    let resolveSecond: (url: string) => void;

    const firstPromise = new Promise<string>((res) => {
      resolveFirst = res;
    });
    const secondPromise = new Promise<string>((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    const mockResolver: ImageSourceResolver = () => {
      callCount++;
      if (callCount === 1) return firstPromise;
      return secondPromise;
    };

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-async-test',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    const srcInput = popover.querySelector('.cm-image-src-input') as HTMLInputElement;

    // First click: pending
    uploadBtn.click();
    // Second click: newer pending
    uploadBtn.click();

    // Resolve second request first (out of order)
    resolveSecond!('./second.png');
    await Promise.resolve();
    await Promise.resolve();

    expect(srcInput.value).toBe('./second.png');

    // Resolve first request later (outdated)
    resolveFirst!('./first.png');
    await Promise.resolve();
    await Promise.resolve();

    // Must NOT be overwritten by the stale first response!
    expect(srcInput.value).toBe('./second.png');

    visualHandle.destroy();
  });

  it('clicking inline code widget opens code editor, modifying code updates session', () => {
    const source = 'Run `npm test` here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-code-test',
      surfaceKind: 'visual'
    });

    const codeWidget = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(codeWidget).not.toBeNull();

    codeWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();

    const codeInput = popover.querySelector('.cm-code-input') as HTMLInputElement;
    expect(codeInput).not.toBeNull();
    expect(codeInput.value).toBe('npm test');

    codeInput.value = 'pnpm test';
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('Run `pnpm test` here.');
    expect(session.getSnapshot().revision).toBe(1);

    visualHandle.destroy();
  });

  it('clicking WikiLink widget opens WikiLink editor, modifying target and alias updates session', () => {
    const source = 'See [[OldDoc|OldAlias]] link.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-wiki-test',
      surfaceKind: 'visual'
    });

    const wikiWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    expect(wikiWidget).not.toBeNull();

    wikiWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();

    const targetInput = popover.querySelector('.cm-wikilink-target-input') as HTMLInputElement;
    const aliasInput = popover.querySelector('.cm-wikilink-alias-input') as HTMLInputElement;
    expect(targetInput).not.toBeNull();
    expect(aliasInput).not.toBeNull();
    expect(targetInput.value).toBe('OldDoc');
    expect(aliasInput.value).toBe('OldAlias');

    targetInput.value = 'NewDoc';
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    aliasInput.value = 'NewAlias';
    aliasInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('See [[NewDoc|NewAlias]] link.');
    expect(session.getSnapshot().revision).toBe(1);

    visualHandle.destroy();
  });

  it('stale revision immediately closes Popover without commit or fake error text', () => {
    const source = 'Check [Doc](https://nexus.dev) out.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-stale-close-test',
      surfaceKind: 'visual'
    });

    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    // External change to source
    session.dispatch({
      changes: [{ from: 0, to: 5, insert: 'Read' }],
      userEvent: 'external.update'
    });

    // Popover must be closed immediately
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().revision).toBe(1); // Only the external edit revision

    visualHandle.destroy();
  });

  it('WikiLink widget prioritizes displaying alias over target | alias', () => {
    const source = 'See [[MyTarget|MyCustomAlias]] and [[OnlyTarget]] here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-wikilink-display-test',
      surfaceKind: 'visual'
    });

    const widgets = visualHandle.view.dom.querySelectorAll('.cm-visual-wikilink');
    expect(widgets.length).toBe(2);

    const aliasWidget = widgets[0] as HTMLElement;
    expect(aliasWidget.textContent).toBe('MyCustomAlias');
    expect(aliasWidget.title).toBe('MyTarget');
    expect(aliasWidget.getAttribute('aria-label')).toContain('MyCustomAlias');

    const noAliasWidget = widgets[1] as HTMLElement;
    expect(noAliasWidget.textContent).toBe('OnlyTarget');
    expect(noAliasWidget.title).toBe('OnlyTarget');

    visualHandle.destroy();
  });

  it('dual surface Inline Code edit updates canonical source, syncs Source surface, and supports undo/redo', () => {
    const source = 'Run `npm test` here.';
    const session = new MarkdownDocumentSession(source);
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-code-dual',
      surfaceKind: 'visual'
    });
    const sourceHandle = createSessionEditorView({
      parent: sourceParent,
      session,
      surfaceId: 's-code-dual',
      surfaceKind: 'source'
    });

    const initialRevision = session.getSnapshot().revision;
    const codeWidget = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    codeWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const codeInput = popover.querySelector('.cm-code-input') as HTMLInputElement;
    codeInput.value = 'pnpm test';
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('Run `pnpm test` here.');
    expect(session.getSnapshot().revision).toBe(initialRevision + 1);
    expect(sourceHandle.view.state.doc.toString()).toBe('Run `pnpm test` here.');

    const updatedWidget = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(updatedWidget.textContent).toBe('pnpm test');

    // 1 Undo
    session.undo();
    expect(session.getSnapshot().source).toBe('Run `npm test` here.');
    expect(sourceHandle.view.state.doc.toString()).toBe('Run `npm test` here.');
    const revertedWidget = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(revertedWidget.textContent).toBe('npm test');

    // Redo
    session.redo();
    expect(session.getSnapshot().source).toBe('Run `pnpm test` here.');
    expect(sourceHandle.view.state.doc.toString()).toBe('Run `pnpm test` here.');

    visualHandle.destroy();
    sourceHandle.destroy();
    document.body.removeChild(sourceParent);
  });

  it('dual surface WikiLink edit updates canonical source, syncs Source surface, and supports undo/redo', () => {
    const source = 'See [[PageA|OldAlias]] now.';
    const session = new MarkdownDocumentSession(source);
    const sourceParent = document.createElement('div');
    document.body.appendChild(sourceParent);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-wiki-dual',
      surfaceKind: 'visual'
    });
    const sourceHandle = createSessionEditorView({
      parent: sourceParent,
      session,
      surfaceId: 's-wiki-dual',
      surfaceKind: 'source'
    });

    const initialRevision = session.getSnapshot().revision;
    const wikiWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const aliasInput = popover.querySelector('.cm-wikilink-alias-input') as HTMLInputElement;
    aliasInput.value = 'NewAlias';
    aliasInput.dispatchEvent(new Event('input', { bubbles: true }));

    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    saveBtn.click();

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('See [[PageA|NewAlias]] now.');
    expect(session.getSnapshot().revision).toBe(initialRevision + 1);
    expect(sourceHandle.view.state.doc.toString()).toBe('See [[PageA|NewAlias]] now.');

    const updatedWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    expect(updatedWidget.textContent).toBe('NewAlias');

    // 1 Undo
    session.undo();
    expect(session.getSnapshot().source).toBe('See [[PageA|OldAlias]] now.');
    expect(sourceHandle.view.state.doc.toString()).toBe('See [[PageA|OldAlias]] now.');
    const revertedWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    expect(revertedWidget.textContent).toBe('OldAlias');

    // Redo
    session.redo();
    expect(session.getSnapshot().source).toBe('See [[PageA|NewAlias]] now.');
    expect(sourceHandle.view.state.doc.toString()).toBe('See [[PageA|NewAlias]] now.');

    visualHandle.destroy();
    sourceHandle.destroy();
    document.body.removeChild(sourceParent);
  });

  it('two Visual Surfaces opening popovers do not clean up or pollute each other', () => {
    const source = 'Visit [Link](https://nexus.dev) and ![Img](./pic.png)';
    const session = new MarkdownDocumentSession(source);
    const parent2 = document.createElement('div');
    document.body.appendChild(parent2);

    const visual1 = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-multi-1',
      surfaceKind: 'visual'
    });
    const visual2 = createSessionEditorView({
      parent: parent2,
      session,
      surfaceId: 'v-multi-2',
      surfaceKind: 'visual'
    });

    const linkWidget1 = visual1.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const imgWidget2 = visual2.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // Both popovers must exist simultaneously
    const popover1 = visual1.view.dom.querySelector('.cm-inline-edit-popover');
    const popover2 = visual2.view.dom.querySelector('.cm-inline-edit-popover');
    expect(popover1).not.toBeNull();
    expect(popover2).not.toBeNull();

    // Typing in Popover 2 must not affect Popover 1
    const altInput2 = popover2!.querySelector('.cm-image-alt-input') as HTMLInputElement;
    altInput2.value = 'Different Alt';
    altInput2.dispatchEvent(new Event('input', { bubbles: true }));

    const labelInput1 = popover1!.querySelector('.cm-link-label-input') as HTMLInputElement;
    expect(labelInput1.value).toBe('Link');

    // Cancel Popover 2 -> Popover 1 remains open
    const cancelBtn2 = popover2!.querySelector('.cm-inline-edit-cancel') as HTMLButtonElement;
    cancelBtn2.click();

    expect(visual2.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(visual1.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    visual1.destroy();
    visual2.destroy();
    document.body.removeChild(parent2);
  });

  it('ImageSourceResolver does not overwrite user manual edits during in-flight upload', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveUpload: (url: string) => void;
    const uploadPromise = new Promise<string>((res) => {
      resolveUpload = res;
    });

    const mockResolver: ImageSourceResolver = () => uploadPromise;

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-manual-override',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    const srcInput = popover.querySelector('.cm-image-src-input') as HTMLInputElement;

    uploadBtn.click();

    // User manually types while upload is pending
    srcInput.value = './user-manual.png';
    srcInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Upload resolves later
    resolveUpload!('./uploaded.png');
    await Promise.resolve();
    await Promise.resolve();

    // Must NOT overwrite manual user input!
    expect(srcInput.value).toBe('./user-manual.png');

    visualHandle.destroy();
  });

  it('stale ImageSourceResolver rejection does not display error or overwrite successful UI', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let rejectFirst: (err: Error) => void;
    let resolveSecond: (url: string) => void;

    const firstPromise = new Promise<string>((_, rej) => {
      rejectFirst = rej;
    });
    const secondPromise = new Promise<string>((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    const mockResolver: ImageSourceResolver = () => {
      callCount++;
      if (callCount === 1) return firstPromise;
      return secondPromise;
    };

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-stale-reject',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    const srcInput = popover.querySelector('.cm-image-src-input') as HTMLInputElement;
    const errorEl = popover.querySelector('.cm-inline-edit-error') as HTMLElement;

    // First request
    uploadBtn.click();
    // Second request
    uploadBtn.click();

    // Second succeeds first
    resolveSecond!('./second-ok.png');
    await Promise.resolve();
    await Promise.resolve();

    expect(srcInput.value).toBe('./second-ok.png');
    expect(errorEl.textContent).toBe('');

    // First fails later (stale)
    rejectFirst!(new Error('First request timeout'));
    await Promise.resolve();
    await Promise.resolve();

    // Error must NOT be shown
    expect(errorEl.textContent).toBe('');
    expect(srcInput.value).toBe('./second-ok.png');

    visualHandle.destroy();
  });

  it('disables destination input in Popover for reference-style link and prevents silent inline mutation', () => {
    const source = 'See [My Ref][ref1] here.\n\n[ref1]: https://nexus.dev';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-ref-link',
      surfaceKind: 'visual'
    });

    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();

    const destInput = popover.querySelector('.cm-link-dest-input') as HTMLInputElement;
    expect(destInput.disabled || destInput.readOnly).toBe(true);

    visualHandle.destroy();
  });

  it('ImageSourceResolver with input versioning: user edits src manually, then clicks upload -> resolver result is accepted', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveUpload: (url: string) => void;
    const uploadPromise = new Promise<string>((res) => {
      resolveUpload = res;
    });

    const mockResolver: ImageSourceResolver = () => uploadPromise;

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-manual-then-upload',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    const srcInput = popover.querySelector('.cm-image-src-input') as HTMLInputElement;

    // User first manually edits src
    srcInput.value = './typed-first.png';
    srcInput.dispatchEvent(new Event('input', { bubbles: true }));

    // THEN user clicks upload
    uploadBtn.click();

    // Upload resolves later
    resolveUpload!('./uploaded-final.png');
    await Promise.resolve();
    await Promise.resolve();

    // Under input-version mechanism, this active upload MUST succeed because it was initiated after the manual edit!
    expect(srcInput.value).toBe('./uploaded-final.png');

    visualHandle.destroy();
  });

  it('ImageSourceResolver: Popover closed before resolve/reject has no effect and does not throw', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveUpload: (url: string) => void;
    const uploadPromise = new Promise<string>((res) => {
      resolveUpload = res;
    });

    const mockResolver: ImageSourceResolver = () => uploadPromise;

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-close-before-res',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    uploadBtn.click();

    // User hits Escape to close popover
    popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

    // Resolver resolves after closure
    resolveUpload!('./late.png');
    await Promise.resolve();
    await Promise.resolve();

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    visualHandle.destroy();
  });

  it('ImageSourceResolver: Surface destroyed before resolve/reject has no effect and does not throw', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveUpload: (url: string) => void;
    const uploadPromise = new Promise<string>((res) => {
      resolveUpload = res;
    });

    const mockResolver: ImageSourceResolver = () => uploadPromise;

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-destroy-before-res',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    uploadBtn.click();

    visualHandle.destroy();

    // Resolver resolves after destroy
    resolveUpload!('./late.png');
    await Promise.resolve();
    await Promise.resolve();
  });

  it('ImageSourceResolver: external document revision change drops resolver result', async () => {
    const source = 'Photo: ![Img](./img.png)';
    const session = new MarkdownDocumentSession(source);

    let resolveUpload: (url: string) => void;
    const uploadPromise = new Promise<string>((res) => {
      resolveUpload = res;
    });

    const mockResolver: ImageSourceResolver = () => uploadPromise;

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-rev-change',
      surfaceKind: 'visual',
      imageSourceResolver: mockResolver
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    const uploadBtn = popover.querySelector('.cm-image-upload-btn') as HTMLButtonElement;
    const srcInput = popover.querySelector('.cm-image-src-input') as HTMLInputElement;
    uploadBtn.click();

    // External revision happens
    session.dispatch({
      changes: [{ from: 0, to: 0, insert: 'Prefix: ' }]
    });

    // Resolver finishes
    resolveUpload!('./late.png');
    await Promise.resolve();
    await Promise.resolve();

    // Stale result must not be written
    expect(srcInput.value).toBe('./img.png');
    visualHandle.destroy();
  });

  it('disables title input in Popover for reference-style link and image', () => {
    const source = 'See [My Ref][ref1] and ![My Img][img1].\n\n[ref1]: https://nexus.dev "Link Title"\n[img1]: /img.png "Img Title"';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-ref-title-disabled',
      surfaceKind: 'visual'
    });

    // 1. Link reference popover
    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const linkPopover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(linkPopover).not.toBeNull();
    const linkTitleInput = linkPopover.querySelector('.cm-link-title-input') as HTMLInputElement;
    expect(linkTitleInput.disabled || linkTitleInput.readOnly).toBe(true);

    // Close popover
    linkPopover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    // 2. Image reference popover
    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const imgPopover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(imgPopover).not.toBeNull();
    const imgTitleInput = imgPopover.querySelector('.cm-image-title-input') as HTMLInputElement;
    expect(imgTitleInput.disabled || imgTitleInput.readOnly).toBe(true);

    visualHandle.destroy();
  });

  it('disables label/alt input and save button for shortcut reference', () => {
    const source = 'See [myref] shortcut.\n\n[myref]: https://nexus.dev';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-shortcut-ref',
      surfaceKind: 'visual'
    });

    const linkWidget = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    const labelInput = popover.querySelector('.cm-link-label-input') as HTMLInputElement;
    const saveBtn = popover.querySelector('.cm-inline-edit-save') as HTMLButtonElement;
    expect(labelInput.disabled || labelInput.readOnly).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    visualHandle.destroy();
  });

  it('destroying Surface 2 does NOT close Surface 1 active popover', () => {
    const source = 'See [Nexus](https://nexus.dev) in visual mode.';
    const session = new MarkdownDocumentSession(source);

    const parent2 = document.createElement('div');
    document.body.appendChild(parent2);

    const visual1 = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v1-iso',
      surfaceKind: 'visual'
    });

    const visual2 = createSessionEditorView({
      parent: parent2,
      session,
      surfaceId: 'v2-iso',
      surfaceKind: 'visual'
    });

    const linkWidget1 = visual1.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(visual1.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    // Destroy Surface 2
    visual2.destroy();

    // Visual 1's popover MUST STILL BE OPEN!
    expect(visual1.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    visual1.destroy();
    visual2.destroy();
    document.body.removeChild(parent2);
  });

  it('clicking normal editing area of another Surface closes current popover', () => {
    const source = 'Line 1: [Nexus](https://nexus.dev)\nLine 2: Other content';
    const session = new MarkdownDocumentSession(source);

    const parent2 = document.createElement('div');
    document.body.appendChild(parent2);

    const visual1 = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v1-click-test',
      surfaceKind: 'visual'
    });

    const source2 = createSessionEditorView({
      parent: parent2,
      session,
      surfaceId: 's2-click-test',
      surfaceKind: 'source'
    });

    // Open popover on visual 1
    const linkWidget1 = visual1.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    linkWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(visual1.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    // Click normal editing area of surface 2 (source editor line content)
    const otherContent = source2.view.dom.querySelector('.cm-content') as HTMLElement;
    otherContent.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));

    // Current popover in visual 1 MUST BE CLOSED!
    expect(visual1.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

    visual1.destroy();
    source2.destroy();
    document.body.removeChild(parent2);
  });
});
