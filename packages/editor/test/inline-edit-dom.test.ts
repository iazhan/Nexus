// @vitest-environment happy-dom
import { EditorSelection } from '@codemirror/state';
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

  it('renders a link as blocked when its destination is rewritten to a dangerous protocol', () => {
    const source = 'Check [Doc](https://nexus.dev) out.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-blocked-url-test',
      surfaceKind: 'visual'
    });

    // 链接文字是真实文档文本，目的地由 data-safe-href 承载
    const linkText = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(linkText).not.toBeNull();
    expect(linkText.textContent).toBe('Doc');
    expect(linkText.getAttribute('data-safe-href')).toBe('https://nexus.dev');
    expect(linkText.classList.contains('cm-visual-link-blocked')).toBe(false);

    // 就地改写目的地，等价于用户在 `](...)` 区间内输入
    const destStart = source.indexOf('https://nexus.dev');
    visualHandle.view.dispatch({
      changes: {
        from: destStart,
        to: destStart + 'https://nexus.dev'.length,
        insert: 'javascript:alert(1)'
      }
    });

    const blocked = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(blocked.classList.contains('cm-visual-link-blocked')).toBe(true);
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    // 危险协议绝不进入任何可点击属性
    expect(blocked.getAttribute('data-safe-href')).toBeNull();
    expect(blocked.getAttribute('href')).toBeNull();
    // 正文本身保持可编辑，不会被降级成不可编辑的占位
    expect(blocked.textContent).toBe('Doc');

    visualHandle.destroy();
  });

  it('clicking Save without modifying values cleanly closes Popover without error or revision increment', () => {
    const source = 'See [[Doc]] here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-unchanged-test',
      surfaceKind: 'visual'
    });

    const wikiWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const popover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(popover).not.toBeNull();
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

  it('renders inline code as in-place editable text with hidden backticks and no popover', () => {
    const source = 'Run `npm test` here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-code-test',
      surfaceKind: 'visual'
    });

    // 与 bold/italic 同构：正文是真实文档文本，只被 mark 装饰包裹，不再是 widget。
    expect(visualHandle.view.dom.querySelector('.cm-visual-inline-code-widget')).toBeNull();

    const codeText = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(codeText).not.toBeNull();
    expect(codeText.textContent).toBe('npm test');

    // 反引号围栏被替换为隐藏 delimiter，与 ** 的显隐契约一致。
    const backtickDelimiters = Array.from(
      visualHandle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter')
    ).filter((element) => (element as HTMLElement).dataset.delimiter === '`');
    expect(backtickDelimiters).toHaveLength(2);

    // 点击不再被拦截，也不再打开 popover：事件必须原样交回 CodeMirror，
    // 否则光标落不进去、就地编辑形同虚设。
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    codeText.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

    visualHandle.destroy();
  });

  it('keeps multi-backtick fences intact so code containing a backtick stays editable', () => {
    const source = 'Run ``a`b`` here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-code-fence',
      surfaceKind: 'visual'
    });

    expect(visualHandle.view.dom.querySelector('.cm-visual-inline-code-widget')).toBeNull();
    expect(visualHandle.view.dom.querySelector('.cm-visual-inline-code')?.textContent).toBe('a`b');

    // 围栏长度必须按原文长度成对隐藏，不能塌缩成单反引号。
    const fences = Array.from(
      visualHandle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter')
    ).filter((element) => (element as HTMLElement).dataset.delimiter === '``');
    expect(fences).toHaveLength(2);
    expect(session.getSnapshot().source).toBe(source);

    visualHandle.destroy();
  });

  it('reveals backtick delimiters when the caret enters the inline code span', () => {
    const source = 'Run `npm test` here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-code-reveal',
      surfaceKind: 'visual'
    });

    visualHandle.view.focus();
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-delimiter-revealed')).toHaveLength(0);

    // 光标落在正文内部：围栏显示出来，用户可以看清并直接编辑 Markdown 结构。
    visualHandle.view.dispatch({
      selection: EditorSelection.single(source.indexOf('npm test') + 3)
    });

    const revealed = visualHandle.view.dom.querySelectorAll('.cm-visual-delimiter-revealed');
    expect(revealed).toHaveLength(2);
    expect(Array.from(revealed, (element) => element.textContent).join('')).toBe('``');
    // 仅进入投影，不产生任何编辑。
    expect(session.getSnapshot()).toMatchObject({ source, revision: 0 });

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
    const source = 'See [[Doc]] here.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-stale-close-test',
      surfaceKind: 'visual'
    });

    const wikiWidget = visualHandle.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).not.toBeNull();

    // External change to source
    session.dispatch({
      changes: [{ from: 0, to: 3, insert: 'Read' }],
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

    // 就地编辑 = 直接改写正文区间的普通 source transaction，与用户敲键产生的编辑等价。
    // 没有 popover、输入框和提交按钮参与，也不需要任何专用事务构造函数。
    const innerFrom = source.indexOf('`') + 1;
    const innerTo = source.indexOf('`', innerFrom);
    visualHandle.view.dispatch({
      changes: { from: innerFrom, to: innerTo, insert: 'pnpm test' },
      selection: EditorSelection.single(innerFrom + 'pnpm test'.length)
    });

    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();
    expect(session.getSnapshot().source).toBe('Run `pnpm test` here.');
    expect(session.getSnapshot().revision).toBe(initialRevision + 1);
    expect(sourceHandle.view.state.doc.toString()).toBe('Run `pnpm test` here.');

    const updatedCode = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(updatedCode.textContent).toBe('pnpm test');

    // 1 Undo
    session.undo();
    expect(session.getSnapshot().source).toBe('Run `npm test` here.');
    expect(sourceHandle.view.state.doc.toString()).toBe('Run `npm test` here.');
    const revertedCode = visualHandle.view.dom.querySelector('.cm-visual-inline-code') as HTMLElement;
    expect(revertedCode.textContent).toBe('npm test');

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
    const source = 'Visit [[Link]] and ![Img](./pic.png)';
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

    const wikiWidget1 = visual1.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

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

    const targetInput1 = popover1!.querySelector('.cm-wikilink-target-input') as HTMLInputElement;
    expect(targetInput1.value).toBe('Link');

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

  it('keeps reference-style links editable in place without touching the definition line', () => {
    const source = 'See [My Ref][ref1] here.\n\n[ref1]: https://nexus.dev';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-ref-link',
      surfaceKind: 'visual'
    });

    // 链接文字是真实文档文本；`][ref1]` 与定义行都由投影隐藏，不会被 popover 改写
    const linkText = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(linkText).not.toBeNull();
    expect(linkText.textContent).toBe('My Ref');
    // 目的地由定义行解析而来，只作信息承载，不产生可点击目标
    expect(linkText.getAttribute('data-safe-href')).toBe('https://nexus.dev');
    expect(linkText.getAttribute('href')).toBeNull();

    // 点击不再开 popover，也就没有「误改引用标签」的路径
    linkText.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

    // 就地改写链接文字：引用标签与定义行必须原样保留
    const textStart = source.indexOf('My Ref');
    visualHandle.view.dispatch({
      changes: { from: textStart, to: textStart + 'My Ref'.length, insert: 'Renamed' }
    });

    expect(session.getSnapshot().source).toBe(
      'See [Renamed][ref1] here.\n\n[ref1]: https://nexus.dev'
    );

    visualHandle.destroy();
  });

  it('renders visible list markers for unordered, ordered and task items', () => {
    const source = [
      '- Alpha',
      '- Beta',
      '',
      '1. First',
      '2. Second',
      '',
      '10. Tenth',
      '',
      '- [ ] Todo',
      '- [x] Done'
    ].join('\n');
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-list-marker',
      surfaceKind: 'visual'
    });

    // 回归：有序列表的数字曾被 DelimiterWidget 吞掉（落进 display:none 的隐藏分隔符），
    // 行首只剩空白，编号整段消失。现在统一由 ListMarkerWidget 提供可见替身。
    const markers = Array.from(
      visualHandle.view.dom.querySelectorAll('.cm-visual-list-marker')
    ) as HTMLElement[];
    expect(markers.map((marker) => marker.textContent)).toEqual([
      '•',
      '•',
      '1.',
      '2.',
      '10.',
      '•',
      '•'
    ]);

    // 替身必须真的可见，不能混进隐藏分隔符
    for (const marker of markers) {
      expect(marker.classList.contains('cm-visual-hidden-delimiter')).toBe(false);
    }
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter').length).toBe(0);

    // 有序标记单独成类，供 tabular-nums 对齐
    const orderedMarkers = visualHandle.view.dom.querySelectorAll('.cm-visual-list-marker-ordered');
    expect(orderedMarkers.length).toBe(3);

    // 任务项的 `-` 也换成与普通项一致的圆点，只剩复选框作为差异
    expect(visualHandle.view.dom.querySelectorAll('.cm-visual-task-checkbox').length).toBe(2);
    expect(visualHandle.view.dom.textContent).not.toContain('- [ ]');

    visualHandle.destroy();
  });

  it('reveals the raw list marker text when the caret enters the item', () => {
    const source = '- Alpha\n\n1. First';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-list-marker-reveal',
      surfaceKind: 'visual'
    });

    // 光标在项外：显示替身
    expect(
      Array.from(visualHandle.view.dom.querySelectorAll('.cm-visual-list-marker')).map(
        (marker) => marker.textContent
      )
    ).toEqual(['•', '1.']);

    // reveal 只在聚焦时生效，与 bold / 行内代码共用同一套契约
    visualHandle.view.focus();

    // 光标落进第一项正文：marker 还原为真实源码文本，保证可以直接改 `-` 为 `1.`
    visualHandle.view.dispatch({ selection: EditorSelection.single(3) });
    const revealed = Array.from(
      visualHandle.view.dom.querySelectorAll('.cm-visual-delimiter-revealed')
    ).map((element) => (element as HTMLElement).dataset.delimiter);
    expect(revealed).toContain('-');

    // 第二项没被选中，仍保持替身
    expect(
      Array.from(visualHandle.view.dom.querySelectorAll('.cm-visual-list-marker')).map(
        (marker) => marker.textContent
      )
    ).toEqual(['1.']);

    visualHandle.destroy();
  });

  it('opens no popover when clicking a normal link, and keeps the label as real editable text', () => {
    const source = 'Read [the guide](https://nexus.dev/guide) now.';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-link-inplace',
      surfaceKind: 'visual'
    });

    // 回归：链接此前是整节点 widget（带编辑按钮的 popover），现在与 bold / 行内代码同构
    expect(visualHandle.view.dom.querySelector('.cm-visual-link-widget')).toBeNull();

    const linkText = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(linkText).not.toBeNull();
    expect(linkText.textContent).toBe('the guide');

    // 链接文字必须是真实文档文本：能在文档里定位到，且与源码字节一致
    const textPos = visualHandle.view.posAtDOM(linkText, 0);
    expect(visualHandle.view.state.doc.sliceString(textPos, textPos + 'the guide'.length)).toBe(
      'the guide'
    );

    // 方括号与 `](...)` 都收进隐藏分隔符，点击不再被拦截
    const delimiters = Array.from(
      visualHandle.view.dom.querySelectorAll('.cm-visual-hidden-delimiter')
    ).map((element) => (element as HTMLElement).dataset.delimiter);
    expect(delimiters).toContain('[');
    expect(delimiters).toContain('](https://nexus.dev/guide)');

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    linkText.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

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

  it('disables title input in Popover for reference-style image', () => {
    const source = 'See ![My Img][img1].\n\n[img1]: /img.png "Img Title"';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-ref-title-disabled',
      surfaceKind: 'visual'
    });

    const imgWidget = visualHandle.view.dom.querySelector('.cm-visual-image') as HTMLElement;
    imgWidget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const imgPopover = visualHandle.view.dom.querySelector('.cm-inline-edit-popover') as HTMLElement;
    expect(imgPopover).not.toBeNull();
    const imgTitleInput = imgPopover.querySelector('.cm-image-title-input') as HTMLInputElement;
    expect(imgTitleInput.disabled || imgTitleInput.readOnly).toBe(true);

    visualHandle.destroy();
  });

  it('keeps shortcut reference links editable in place', () => {
    const source = 'See [myref] shortcut.\n\n[myref]: https://nexus.dev';
    const session = new MarkdownDocumentSession(source);

    const visualHandle = createSessionEditorView({
      parent,
      session,
      surfaceId: 'v-shortcut-ref',
      surfaceKind: 'visual'
    });

    const linkText = visualHandle.view.dom.querySelector('.cm-visual-link') as HTMLElement;
    expect(linkText).not.toBeNull();
    expect(linkText.textContent).toBe('myref');

    // 不再有 popover，也就没有 label 输入框或 Save 按钮可供误用
    linkText.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(visualHandle.view.dom.querySelector('.cm-inline-edit-popover')).toBeNull();

    // 就地改写快捷引用的标签，定义行保持原样
    const textStart = source.indexOf('[myref]') + 1;
    visualHandle.view.dispatch({
      changes: { from: textStart, to: textStart + 'myref'.length, insert: 'renamed' }
    });

    expect(session.getSnapshot().source).toBe(
      'See [renamed] shortcut.\n\n[myref]: https://nexus.dev'
    );

    visualHandle.destroy();
  });

  it('destroying Surface 2 does NOT close Surface 1 active popover', () => {
    const source = 'See [[Nexus]] in visual mode.';
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

    const wikiWidget1 = visual1.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

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
    const source = 'Line 1: [[Nexus]]\nLine 2: Other content';
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
    const wikiWidget1 = visual1.view.dom.querySelector('.cm-visual-wikilink') as HTMLElement;
    wikiWidget1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

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
