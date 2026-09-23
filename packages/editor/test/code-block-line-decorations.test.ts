// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  ensureLanguageLoaded
} from '../src/index.js';

describe('Phase 1 - Code Block Line Decorations (Slice 1)', () => {
  const sampleCodeSource = [
    '# Code Document',
    '',
    '```typescript',
    'const a = 1;',
    'console.log(a);',
    '```',
    '',
    'After code.'
  ].join('\n');

  it('projects code block as line decorations with header widget and exit widget instead of full block replacement', () => {
    const session = new MarkdownDocumentSession(sampleCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-line-decorations-1',
      surfaceKind: 'visual',
      parent
    });

    // 1. 不再存在吞没整个代码块的 .cm-visual-code-block Widget
    const fullBlockWidget = handle.view.dom.querySelector('.cm-visual-code-block');
    expect(fullBlockWidget).toBeNull();

    // 2. 首行挂载了包含语言下拉选择与复制按钮的 Header Widget
    const headerWidget = handle.view.dom.querySelector('.cm-code-header-widget');
    expect(headerWidget).not.toBeNull();
    const langSelect = headerWidget?.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
    expect(langSelect).not.toBeNull();
    expect(langSelect?.value).toBe('typescript');
    const copyBtn = headerWidget?.querySelector('.cm-code-copy-btn');
    expect(copyBtn).not.toBeNull();
    const copySvg = copyBtn?.querySelector('svg');
    expect(copySvg).not.toBeNull();

    // 3. 中间代码行作为原生 CodeMirror 文档行存在，带有行号与类名
    const contentLines = handle.view.dom.querySelectorAll('.cm-visual-code-content-line');
    expect(contentLines.length).toBe(2);
    expect(contentLines[0]?.getAttribute('data-code-line-number')).toBe('1');
    expect(contentLines[1]?.getAttribute('data-code-line-number')).toBe('2');
    expect(contentLines[0]?.textContent).toContain('const a = 1;');
    expect(contentLines[1]?.textContent).toContain('console.log(a);');

    // 4. 末行闭合行挂载了 Exit Widget
    const exitWidget = handle.view.dom.querySelector('.cm-code-exit-widget');
    expect(exitWidget).not.toBeNull();

    handle.destroy();
    parent.remove();
  });

  it('clicking Exit widget moves cursor after code block and creates newline if at EOF', () => {
    const session = new MarkdownDocumentSession(sampleCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-exit-click',
      surfaceKind: 'visual',
      parent
    });

    const exitWidget = handle.view.dom.querySelector('.cm-code-exit-widget') as HTMLElement;
    expect(exitWidget).not.toBeNull();

    exitWidget.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));

    // Cursor should be placed at the line after the code block
    const doc = handle.view.state.doc.toString();
    const afterCodePos = doc.indexOf('After code.');
    expect(handle.view.state.selection.main.head).toBeGreaterThanOrEqual(doc.indexOf('```') + 3);

    handle.destroy();
    parent.remove();
  });

  it('smart enter on empty line at end of code block exits code block into new paragraph', () => {
    const codeWithEmptyEnd = [
      '# Document',
      '',
      '```typescript',
      'const a = 1;',
      '',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(codeWithEmptyEnd);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-smart-enter',
      surfaceKind: 'visual',
      parent
    });

    // Locate the empty line inside the code block (between 'const a = 1;' and '```')
    const constPos = codeWithEmptyEnd.indexOf('const a = 1;\n');
    const emptyLinePos = constPos + 'const a = 1;\n'.length;
    handle.view.dispatch({
      selection: { anchor: emptyLinePos }
    });

    // Press Enter on the empty line
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    handle.view.contentDOM.dispatchEvent(event);

    // The empty line inside the code block should be cleared, and a new paragraph created after the closing fence
    const updatedSource = session.getSnapshot().source;
    expect(updatedSource).toBe('# Document\n\n```typescript\nconst a = 1;\n```\n');

    handle.destroy();
    parent.remove();
  });

  it('smart enter on a single empty line in code block preserves opening fence and exits', () => {
    const singleEmptyLineCode = [
      '# Document',
      '',
      '```typescript',
      '',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(singleEmptyLineCode);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-smart-enter-single',
      surfaceKind: 'visual',
      parent
    });

    // Locate the empty line inside the code block (immediately after ```typescript\n)
    const fencePos = singleEmptyLineCode.indexOf('```typescript\n');
    const emptyLinePos = fencePos + '```typescript\n'.length;
    handle.view.dispatch({
      selection: { anchor: emptyLinePos }
    });

    // Press Enter on the single empty line
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    handle.view.contentDOM.dispatchEvent(event);

    // The opening fence MUST remain intact (not merged with closing fence)
    const updatedSource = session.getSnapshot().source;
    expect(updatedSource).toBe('# Document\n\n```typescript\n```\n');

    handle.destroy();
    parent.remove();
  });

  it('clicking Exit widget always inserts a new paragraph line below code block when followed by text', () => {
    const codeFollowedDirectly = [
      '# Document',
      '',
      '```typescript',
      'const a = 1;',
      '```',
      'Followed directly.'
    ].join('\n');

    const session = new MarkdownDocumentSession(codeFollowedDirectly);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-exit-insert-paragraph',
      surfaceKind: 'visual',
      parent
    });

    const exitWidget = handle.view.dom.querySelector('.cm-code-exit-widget') as HTMLElement;
    expect(exitWidget).not.toBeNull();

    exitWidget.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));

    // A new empty line (paragraph) should be inserted between the closing fence and 'Followed directly.'
    const updatedSource = session.getSnapshot().source;
    expect(updatedSource).toBe(
      '# Document\n\n```typescript\nconst a = 1;\n```\n\nFollowed directly.'
    );

    // Cursor should be placed on the newly inserted line
    const fenceEnd = updatedSource.indexOf('```\n') + '```\n'.length;
    expect(handle.view.state.selection.main.head).toBe(fenceEnd);

    handle.destroy();
    parent.remove();
  });

  it('smart enter on empty line inside code block does not intercept normal typing on non-empty lines', () => {
    const session = new MarkdownDocumentSession(sampleCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-enter-delegate',
      surfaceKind: 'visual',
      parent
    });

    // Position cursor at end of 'const a = 1;' (NOT an empty line)
    const constPos = sampleCodeSource.indexOf('const a = 1;') + 'const a = 1;'.length;
    handle.view.dispatch({ selection: { anchor: constPos } });

    // Press Enter
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    handle.view.contentDOM.dispatchEvent(event);

    // Should NOT exit the code block; should insert newline inside code block
    const updatedSource = session.getSnapshot().source;
    expect(updatedSource).toContain('const a = 1;\n');
    expect(updatedSource).toContain('console.log(a);');

    handle.destroy();
    parent.remove();
  });

  it('renders syntax highlighting tokens for core Lezer languages (e.g. TypeScript)', () => {
    const session = new MarkdownDocumentSession(sampleCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-highlight-lezer',
      surfaceKind: 'visual',
      parent
    });

    // In visual mode, `const` should receive the `.tok-keyword` highlight class
    const keywordToken = handle.view.dom.querySelector('.tok-keyword');
    expect(keywordToken).not.toBeNull();
    expect(keywordToken?.textContent).toBe('const');

    handle.destroy();
    parent.remove();
  });

  it('renders syntax highlighting tokens for non-core languages via language-data', async () => {
    await ensureLanguageLoaded('bash');

    const bashCodeSource = [
      '# Bash Script',
      '',
      '```bash',
      'echo "hello world"',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(bashCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-highlight-bash',
      surfaceKind: 'visual',
      parent
    });

    // In visual mode, language-data parses the bash block with Lezer
    const stringToken = handle.view.dom.querySelector('.tok-string');
    expect(stringToken).not.toBeNull();
    expect(stringToken?.textContent).toBe('"hello world"');

    handle.destroy();
    parent.remove();
  });

  it('renders syntax highlighting tokens for C++ code block as in user screenshot', async () => {
    await ensureLanguageLoaded('cpp');

    const cppCodeSource = [
      '# Document',
      '',
      '```C++',
      'uint8_t a = 999;',
      'void aaa(uint8_t b){',
      '    a += b;',
      '}',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(cppCodeSource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-highlight-cpp',
      surfaceKind: 'visual',
      parent
    });

    const tokenElements = handle.view.dom.querySelectorAll('[class*="tok-"]');
    expect(tokenElements.length).toBeGreaterThan(0);

    handle.destroy();
    parent.remove();
  });

  it('resolves hand-written C# / C++ / lowercase aliases to a grammar and canonical preset option', async () => {
    await Promise.all(['csharp', 'cpp'].map(ensureLanguageLoaded));

    const cFamilySource = [
      '# C Family',
      '',
      '```C#',
      'public class A { int X = 1; }',
      '```',
      '',
      '```c#',
      'int Y = 2;',
      '```',
      '',
      '```C++',
      'int Z = 3;',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(cFamilySource);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-highlight-c-family',
      surfaceKind: 'visual',
      parent
    });

    const tokenElements = handle.view.dom.querySelectorAll('[class*="tok-"]');
    expect(tokenElements.length).toBeGreaterThan(0);

    const selects = Array.from(
      handle.view.dom.querySelectorAll('.cm-code-language-select')
    ) as HTMLSelectElement[];
    // 手写围栏信息串应当选中已有预设项（canonical value），而不是追加自定义选项。
    expect(selects.map((select) => select.value)).toEqual(['csharp', 'csharp', 'cpp']);

    handle.destroy();
    parent.remove();
  });

  it('renders syntax highlighting tokens for additional languages via language-data', async () => {
    await Promise.all(['php', 'ruby', 'swift', 'powershell', 'xml'].map(ensureLanguageLoaded));

    const source = [
      '```php',
      'echo "hi";',
      '```',
      '',
      '```ruby',
      'def f; end',
      '```',
      '',
      '```swift',
      'let a = 1',
      '```',
      '',
      '```powershell',
      'Write-Host "hi"',
      '```',
      '',
      '```xml',
      '<server port="8080" />',
      '```'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-highlight-extra-languages',
      surfaceKind: 'visual',
      parent
    });

    const tokenElements = handle.view.dom.querySelectorAll('[class*="tok-"]');
    expect(tokenElements.length).toBeGreaterThan(0);

    handle.destroy();
    parent.remove();
  });

  it('projects fenced code blocks nested in a blockquote with line numbers and highlighting', () => {
    const source = [
      '# Quote',
      '',
      '> ```ts',
      '> const d = 4;',
      '> console.log(d);',
      '> ```',
      '',
      'After quote.'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-quote-fence',
      surfaceKind: 'visual',
      parent
    });

    // 首行围栏被替换为 header widget（此前整块退化成原文，没有 header）
    const headerWidget = handle.view.dom.querySelector('.cm-code-header-widget');
    expect(headerWidget).not.toBeNull();
    const langSelect = headerWidget?.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
    expect(langSelect?.value).toBe('typescript');

    // 中间两行成为带行号的原生文档行
    const contentLines = handle.view.dom.querySelectorAll('.cm-visual-code-content-line');
    expect(contentLines.length).toBe(2);
    expect(contentLines[0]?.getAttribute('data-code-line-number')).toBe('1');
    expect(contentLines[1]?.getAttribute('data-code-line-number')).toBe('2');
    expect(contentLines[0]?.textContent).toContain('const d = 4;');
    expect(contentLines[1]?.textContent).toContain('console.log(d);');

    // 末行挂载 exit widget
    expect(handle.view.dom.querySelector('.cm-code-exit-widget')).not.toBeNull();

    // Lezer 原生高亮在引用块内同样生效
    const keywordToken = handle.view.dom.querySelector('.tok-keyword');
    expect(keywordToken).not.toBeNull();
    expect(keywordToken?.textContent).toBe('const');

    handle.destroy();
    parent.remove();
  });

  it('renders indented (fence-less) code blocks as code lines with line numbers', () => {
    // 末尾空行按 CommonMark 不属于缩进式代码块内容，不应占用行号
    const source = ['# Doc', '', '    const c = 3;', '    return c;', '', 'After block.', ''].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-indented-block',
      surfaceKind: 'visual',
      parent
    });

    // 缩进式代码块没有围栏行，因此不生成 header / exit widget
    expect(handle.view.dom.querySelector('.cm-code-header-widget')).toBeNull();
    expect(handle.view.dom.querySelector('.cm-code-exit-widget')).toBeNull();

    const contentLines = handle.view.dom.querySelectorAll('.cm-visual-code-content-line');
    expect(contentLines.length).toBe(2);
    expect(contentLines[0]?.getAttribute('data-code-line-number')).toBe('1');
    expect(contentLines[1]?.getAttribute('data-code-line-number')).toBe('2');
    expect(contentLines[0]?.classList.contains('cm-visual-code-plain-first-line')).toBe(true);
    expect(contentLines[1]?.classList.contains('cm-visual-code-plain-last-line')).toBe(true);

    handle.destroy();
    parent.remove();
  });

  it('keeps an unclosed fenced code block as raw text', () => {
    const source = ['# Doc', '', '```ts', 'const a = 1;'].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-unclosed-fence',
      surfaceKind: 'visual',
      parent
    });

    expect(handle.view.dom.querySelector('.cm-code-header-widget')).toBeNull();
    expect(handle.view.dom.querySelector('.cm-visual-code-content-line')).toBeNull();

    handle.destroy();
    parent.remove();
  });

  it('attaches data-code-block-from to code block lines and toggles data-code-block-hovered on hover', () => {
    const source = [
      '# Document',
      '',
      '```typescript',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      'Paragraph after code.'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-hover-reveal-test',
      surfaceKind: 'visual',
      parent
    });

    const headerLine = handle.view.dom.querySelector('.cm-visual-code-header-line') as HTMLElement;
    expect(headerLine).not.toBeNull();
    expect(headerLine.dataset.codeBlockFrom).toBeDefined();

    const contentLines = handle.view.dom.querySelectorAll('.cm-visual-code-content-line');
    expect(contentLines.length).toBe(2);
    expect(contentLines[0]?.getAttribute('data-code-block-from')).toBe(headerLine.dataset.codeBlockFrom);
    expect(contentLines[1]?.getAttribute('data-code-block-from')).toBe(headerLine.dataset.codeBlockFrom);

    const closingLine = handle.view.dom.querySelector('.cm-visual-code-closing-line') as HTMLElement;
    expect(closingLine).not.toBeNull();
    expect(closingLine.dataset.codeBlockFrom).toBe(headerLine.dataset.codeBlockFrom);

    // Initial state: not hovered
    expect(headerLine.getAttribute('data-code-block-hovered')).toBeNull();

    // Hover over second content line -> header line should receive data-code-block-hovered="true"
    contentLines[1]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(headerLine.getAttribute('data-code-block-hovered')).toBe('true');

    // Move pointer outside code block to paragraph line -> data-code-block-hovered should be cleared
    const paragraphLine = [...handle.view.dom.querySelectorAll<HTMLElement>('.cm-line')]
      .find((line) => line.textContent?.includes('Paragraph after code.'));
    paragraphLine?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(headerLine.getAttribute('data-code-block-hovered')).toBeNull();

    // Mouse leave editor -> cleared
    contentLines[0]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(headerLine.getAttribute('data-code-block-hovered')).toBe('true');
    handle.view.contentDOM.dispatchEvent(new MouseEvent('mouseleave'));
    expect(headerLine.getAttribute('data-code-block-hovered')).toBeNull();

    handle.destroy();
    parent.remove();
  });

  it('projects fenced code blocks nested in a blockquote with preceding/following text correctly', () => {
    const source = [
      '> 下面是在引用块内部声明的代码块：',
      '> ',
      '> ```typescript',
      '> // 引用块内的 TypeScript 代码块',
      '> export function getQuoteInfo(prefix: string): string {',
      '>   return `Quote: ${prefix.trim()}`;',
      '> }',
      '> ```',
      '>',
      '> 引用块末尾附言。'
    ].join('\n');

    const session = new MarkdownDocumentSession(source);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const handle = createSessionEditorView({
      session,
      surfaceId: 'code-quote-complex',
      surfaceKind: 'visual',
      parent
    });

    // 1. Header line has proper header-line class, quote-nested class, and header widget
    const headerLine = handle.view.dom.querySelector('.cm-visual-code-header-line');
    expect(headerLine).not.toBeNull();
    expect(headerLine?.classList.contains('cm-visual-code-quote-nested')).toBe(true);
    expect(headerLine?.classList.contains('cm-visual-blockquote-line')).toBe(true);

    const headerWidget = handle.view.dom.querySelector('.cm-code-header-widget');
    expect(headerWidget).not.toBeNull();
    const langSelect = headerWidget?.querySelector('.cm-code-language-select') as HTMLSelectElement | null;
    expect(langSelect?.value).toBe('typescript');
    const lineCountBadge = headerWidget?.querySelector('.cm-code-line-count');
    expect(lineCountBadge).not.toBeNull();
    expect(lineCountBadge?.textContent).toBe('4 行');

    // 2. Content lines have line numbers 1-4, quote-nested class, and do not show quote prefix `> `
    const contentLines = handle.view.dom.querySelectorAll('.cm-visual-code-content-line');
    expect(contentLines.length).toBe(4);
    expect(contentLines[0]?.getAttribute('data-code-line-number')).toBe('1');
    expect(contentLines[1]?.getAttribute('data-code-line-number')).toBe('2');
    expect(contentLines[2]?.getAttribute('data-code-line-number')).toBe('3');
    expect(contentLines[3]?.getAttribute('data-code-line-number')).toBe('4');
    expect(contentLines[0]?.classList.contains('cm-visual-code-quote-nested')).toBe(true);
    expect(contentLines[0]?.classList.contains('cm-visual-blockquote-line')).toBe(true);

    expect(contentLines[0]?.textContent).toBe('// 引用块内的 TypeScript 代码块');
    expect(contentLines[1]?.textContent).toBe('export function getQuoteInfo(prefix: string): string {');
    expect(contentLines[2]?.textContent).toBe('  return `Quote: ${prefix.trim()}`;');
    expect(contentLines[3]?.textContent).toBe('}');

    // 3. Syntax highlighting is applied
    const keywordToken = handle.view.dom.querySelector('.tok-keyword');
    expect(keywordToken).not.toBeNull();
    expect(keywordToken?.textContent).toBe('function');

    // 4. Closing line has closing-line class, quote-nested class, and exit widget
    const closingLine = handle.view.dom.querySelector('.cm-visual-code-closing-line');
    expect(closingLine).not.toBeNull();
    expect(closingLine?.classList.contains('cm-visual-code-quote-nested')).toBe(true);
    expect(closingLine?.classList.contains('cm-visual-blockquote-line')).toBe(true);
    expect(closingLine?.querySelector('.cm-code-exit-widget')).not.toBeNull();

    // 5. Surrounding blockquote lines have cm-visual-blockquote-line and hide `> ` delimiter
    const bqLines = handle.view.dom.querySelectorAll('.cm-visual-blockquote-line');
    expect(bqLines.length).toBeGreaterThanOrEqual(6);
    expect(handle.view.dom.textContent).not.toContain('> 下面是在引用块');
    expect(handle.view.dom.textContent).not.toContain('> 引用块末尾附言');

    handle.destroy();
    parent.remove();
  });
});


