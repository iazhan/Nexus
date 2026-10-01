// @vitest-environment happy-dom
import { EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { MarkdownDocumentSession, createSessionEditorView } from '../src/index.js';

/**
 * Source surface 的图片投影。
 *
 * 契约只有一句：**只渲染图片，其余一律保持源码原文**。所以这组用例的重点不在
 * 「图片渲染出来了没有」，而在「别的语法有没有被顺手渲染掉」—— 那是 Source 模式
 * 与 Visual 模式的边界，越过去就等于在源码模式里偷偷开了半个视觉模式。
 */
const DOC_DIR = 'D:/Note/Note';

function mountSource(source: string, surfaceId: string, documentDirectory?: string) {
  const session = new MarkdownDocumentSession(source);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createSessionEditorView({
    session,
    surfaceId,
    surfaceKind: 'source',
    parent,
    ...(documentDirectory === undefined ? {} : { documentDirectory })
  });

  return {
    session,
    parent,
    handle,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    }
  };
}

describe('Source 模式图片投影', () => {
  it('渲染 `![](…)`，而标题 / 粗体 / 行内公式 / 表格一律保持原文', () => {
    const source = [
      '# 标题',
      '',
      '正文 ![](./pic.png) 与 **粗体** 和 $E=mc^2$。',
      '',
      '| 列 | 说明 |',
      '| --- | --- |',
      '| a | b |'
    ].join('\n');
    const mounted = mountSource(source, 'source-image-basic', DOC_DIR);

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.src).toContain('nexus-asset://');

      const text = mounted.parent.textContent ?? '';
      expect(text).toContain('# 标题');
      expect(text).toContain('**粗体**');
      expect(text).toContain('$E=mc^2$');
      expect(text).toContain('| 列 | 说明 |');
      // 投影只影响显示，源文本一个字节都不动
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('`![[x.png]]` 在源码模式同样渲染成图片', () => {
    const source = '前文 ![[pic.png]] 后文';
    const mounted = mountSource(source, 'source-image-embed', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image-embed')).not.toBeNull();
      // `!` 必须一起被替换掉，否则会留下一个孤立的感叹号
      expect(mounted.parent.textContent).not.toContain('![[pic.png]]');
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('`[[x.png]]`（没有 `!`）不是图片，保持源码', () => {
    const mounted = mountSource('前文 [[pic.png]] 后文', 'source-image-plain-wiki', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
      expect(mounted.parent.textContent).toContain('[[pic.png]]');
    } finally {
      mounted.cleanup();
    }
  });

  it('代码围栏里的 `![]()` 是示例代码，不渲染', () => {
    const source = '```md\n![](./pic.png)\n```\n';
    const mounted = mountSource(source, 'source-image-fence', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
      expect(mounted.parent.textContent).toContain('![](./pic.png)');
    } finally {
      mounted.cleanup();
    }
  });

  it('表格单元格里的图片保持原文，不撑坏按字符对齐的列', () => {
    const source = '| 图 | 说明 |\n| --- | --- |\n| ![](./pic.png) | x |\n';
    const mounted = mountSource(source, 'source-image-table', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
      expect(mounted.parent.textContent).toContain('![](./pic.png)');
    } finally {
      mounted.cleanup();
    }
  });

  it('光标落进图片范围内部时，源码与图片同时在场', () => {
    const source = 'x ![](./pic.png) y';
    const mounted = mountSource(source, 'source-image-reveal', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).not.toBeNull();

      const from = source.indexOf('![](');
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(from + 1) });

      // 揭示态**不是**「图片消失」：源码变回真实文本，图片另外插一份并存 ——
      // 于是改地址时看得见效果。这是与行内公式刻意的差别（公式是二选一）。
      const alongside = mounted.parent.querySelector('.cm-visual-image-alongside');
      expect(alongside).not.toBeNull();
      expect(alongside?.querySelector('img')).not.toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-image-source')).not.toBeNull();
      expect(mounted.parent.textContent).toContain('![](./pic.png)');
    } finally {
      mounted.cleanup();
    }
  });

  it('并存态的图片不接点击（没有 data-from/to，不会重开面板）', () => {
    const source = 'x ![](./pic.png) y';
    const mounted = mountSource(source, 'source-image-alongside-click', DOC_DIR);

    try {
      const from = source.indexOf('![](');
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(from + 1) });

      const alongside = mounted.parent.querySelector<HTMLElement>('.cm-visual-image-alongside');
      expect(alongside).not.toBeNull();
      expect(alongside?.dataset.from).toBeUndefined();
      expect(alongside?.dataset.to).toBeUndefined();
    } finally {
      mounted.cleanup();
    }
  });

  it('行中的图片：预览提到行首，整行源码不被劈开', () => {
    const source = '前文 ![](./pic.png) 后文';
    const mounted = mountSource(source, 'source-image-inline-row', DOC_DIR);

    try {
      const from = source.indexOf('![](');
      mounted.handle.view.focus();
      mounted.handle.view.dispatch({ selection: EditorSelection.single(from + 1) });

      const alongside = mounted.parent.querySelector<HTMLElement>('.cm-visual-image-alongside');
      expect(alongside).not.toBeNull();

      // 判据是「预览前面没有正文」：插在节点原位时，`前文 ` 会落在它前面，
      // 块级预览就把这一行劈开了。提到行首后它前面是空的。
      let before = '';
      let node: Node | null = alongside!.previousSibling;
      while (node) {
        before = (node.textContent ?? '') + before;
        node = node.previousSibling;
      }
      expect(before.trim()).toBe('');

      // 整行源码一字不差地留在同一行里
      expect(alongside!.closest('.cm-line')?.textContent).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('没有文档目录时退化成占位符，而不是把相对路径当页面地址加载', () => {
    const mounted = mountSource('![示意图](./pic.png)', 'source-image-no-docdir');

    try {
      expect(mounted.parent.querySelector('.cm-visual-image img')).toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-image-placeholder')?.textContent).toContain(
        '示意图'
      );
    } finally {
      mounted.cleanup();
    }
  });
});
