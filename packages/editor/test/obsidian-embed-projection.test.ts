// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  type LinkNavigationRequest,
  type WorkspaceAssetEntry
} from '../src/index.js';

/**
 * Obsidian 嵌入 `![[x.png]]` 的投影。
 *
 * 解析层刻意**不**把 `![[x.png]]` 归成 `image` 节点 —— 序列化器按节点类型回写源码，
 * 那会让它在往返时变成 `![](x.png)`，打开一次文件就改写用户的源文本。所以识别落在
 * 投影层：`![[…]]` 仍是 wikilink 节点，由投影看它前一个字符是不是 `!` 决定渲染成图片。
 *
 * 这里守的正是这条分界：**渲染成图片，但源文本一个字节都不动**。
 */
function mountVisual(
  source: string,
  surfaceId: string,
  documentDirectory?: string,
  linkNavigator?: (request: LinkNavigationRequest) => boolean | void,
  workspaceAssets?: readonly WorkspaceAssetEntry[]
) {
  const session = new MarkdownDocumentSession(source);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createSessionEditorView({
    session,
    surfaceId,
    surfaceKind: 'visual',
    parent,
    ...(documentDirectory === undefined ? {} : { documentDirectory }),
    ...(linkNavigator === undefined ? {} : { linkNavigator }),
    ...(workspaceAssets === undefined ? {} : { workspaceAssets })
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

const DOC_DIR = 'D:/Note/Note';

/** 造一条工作区资源清单项。`relative` 是**工作区根相对**路径，正斜杠。 */
function asset(relative: string, root = DOC_DIR): WorkspaceAssetEntry {
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return { path: `${root}/${relative}`, relative, name };
}

describe('Obsidian 嵌入投影', () => {
  it('把 `![[x.png]]` 渲染成图片，而不是文字链接', () => {
    const source = '前文\n\n![[pic.png]]\n';
    const mounted = mountVisual(source, 'embed-basic', DOC_DIR);

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.src).toBe('nexus-asset://ws/?path=D%3A%2FNote%2FNote%2Fpic.png');
      // `!` 必须一起被替换掉，否则会留下一个孤立的感叹号。
      expect(mounted.parent.querySelector('.cm-visual-wikilink')).toBeNull();
      expect(mounted.parent.textContent).not.toContain('!pic.png');
    } finally {
      mounted.cleanup();
    }
  });

  it('裸文件名的嵌入按**文档所在目录**解析 —— 图与文档同目录是最常见的写法', () => {
    // 真实 vault 的绝大多数嵌入是 `![[MAIN.png]]` 这种裸文件名，图就放在文档旁边。
    // 按工作区根解析会让它们全部变空白（`D:/Note/Note/MAIN.png` 不存在）。
    const mounted = mountVisual(
      '![[MAIN.png]]',
      'embed-bare-name',
      'D:/Note/Note/EZCODE/2024年终总结'
    );

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(decodeURIComponent(img.src)).toContain('/EZCODE/2024年终总结/MAIN.png');
    } finally {
      mounted.cleanup();
    }
  });

  it('带目录的嵌入按**工作区根相对**解析 —— Obsidian 写的就是这个形状', () => {
    // 真实 vault 里这种写法很常见：图集中放在某个 `图片/` 目录，嵌入直接写从工作区根
    // 算起的完整路径。只按文档目录解析必然空白，而它连报错都不会有。
    const relative = '学习笔记/硬件/笔记/图片/BUCK电路/电路.jpeg';
    const mounted = mountVisual(
      `![[${relative}]]`,
      'embed-root-relative',
      'D:/Note/Note/学习笔记/硬件/笔记',
      undefined,
      [asset(relative)]
    );

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(decodeURIComponent(img.src)).toContain(relative);
    } finally {
      mounted.cleanup();
    }
  });

  it('裸文件名在文档旁边找不到时按**全库同名**兜底', () => {
    // `![[地址分配.png]]`，图却在文档目录下的 `图片/` 子目录里 —— 相对路径算不出来，
    // 只能全库按名找。Obsidian 就是这个语义，而「裸名 + 图在别处」在真实 vault 里
    // 和「裸名 + 图在同目录」一样常见。
    const relative = '学习笔记/工控/笔记/图片/西门子S7-200 SMART/地址分配.png';
    const mounted = mountVisual(
      '![[地址分配.png]]',
      'embed-fallback-name',
      'D:/Note/Note/学习笔记/工控/笔记',
      undefined,
      [asset(relative)]
    );

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(decodeURIComponent(img.src)).toContain(relative);
    } finally {
      mounted.cleanup();
    }
  });

  it('多个同名时取**离当前文档最近**的那个，而不是清单里靠前的', () => {
    // 只按「清单顺序」挑的话，同一篇笔记在两台机器上可能显示不同的图。
    const mounted = mountVisual('![[logo.png]]', 'embed-nearest', 'D:/Note/Note/notes', undefined, [
      asset('brand/logo.png'),
      asset('notes/logo.png')
    ]);

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(decodeURIComponent(img.src)).toContain('/notes/logo.png');
    } finally {
      mounted.cleanup();
    }
  });

  it('清单没递进来时退化成「只有文档目录」单档，不比从前差', () => {
    // 索引还没建好、或宿主不提供这个能力时，`![[MAIN.png]]` 这种最常见写法必须照旧能显示。
    const mounted = mountVisual('![[pic.png]]', 'embed-no-manifest', 'D:/Note/Note/notes');

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(decodeURIComponent(img.src)).toContain('/notes/pic.png');
    } finally {
      mounted.cleanup();
    }
  });

  it('`![](…)` 不吃这套回退链：它只认文档目录相对', () => {
    // 标准 Markdown 的基准。给它加回退会让写出的文档离开本应用就坏 —— 这是刻意的分界。
    const mounted = mountVisual(
      '![](logo.png)',
      'embed-markdown-no-fallback',
      'D:/Note/Note/notes',
      undefined,
      [asset('brand/logo.png')]
    );

    try {
      // 文档目录下没有 `logo.png`，但清单里有同名的一张 —— 不该被它接走。
      expect(decodeURIComponent((mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement).src)).toContain(
        '/notes/logo.png'
      );
    } finally {
      mounted.cleanup();
    }
  });

  it('不改写源文本：投影是显示层，`![[…]]` 原样留在 doc 里', () => {
    const source = '![[pic.png]]';
    const mounted = mountVisual(source, 'embed-source-intact', DOC_DIR);

    try {
      expect(mounted.handle.view.state.doc.toString()).toBe(source);
      expect(mounted.session.getSnapshot().source).toBe(source);
    } finally {
      mounted.cleanup();
    }
  });

  it('`[[x.png]]`（没有 `!`）仍然是 wikilink，不渲染成图片', () => {
    const source = '[[pic.png]]';
    const mounted = mountVisual(source, 'embed-plain-wikilink', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-wikilink')).not.toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  it('转义的 `\\![[x.png]]` 不算嵌入', () => {
    const source = '\\![[pic.png]]';
    const mounted = mountVisual(source, 'embed-escaped', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
      expect(mounted.parent.querySelector('.cm-visual-wikilink')).not.toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  it('`|200` 是像素宽，`|200x300` 只取宽', () => {
    const mounted = mountVisual('![[a.png|200]]\n\n![[b.png|320x180]]', 'embed-width', DOC_DIR);

    try {
      const imgs = Array.from(mounted.parent.querySelectorAll('.cm-visual-image img')) as HTMLImageElement[];
      expect(imgs).toHaveLength(2);
      expect(imgs[0]!.style.width).toBe('200px');
      // 按字面设高会把图压扁，所以高度一律留给 `height: auto` 按比例算。
      expect(imgs[1]!.style.width).toBe('320px');
      expect(imgs[1]!.style.height).toBe('');
    } finally {
      mounted.cleanup();
    }
  });

  it('非数字的 `|` 参数不当作宽度', () => {
    const mounted = mountVisual('![[a.png|说明文字]]', 'embed-non-numeric', DOC_DIR);

    try {
      const img = mounted.parent.querySelector('.cm-visual-image img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.style.width).toBe('');
    } finally {
      mounted.cleanup();
    }
  });

  it('没有文档目录时退化成占位符，而不是把相对路径当页面地址加载', () => {
    const mounted = mountVisual('![[pic.png]]', 'embed-no-docdir');

    try {
      expect(mounted.parent.querySelector('.cm-visual-image img')).toBeNull();
      const placeholder = mounted.parent.querySelector('.cm-visual-image-placeholder');
      expect(placeholder?.textContent).toContain('pic.png');
    } finally {
      mounted.cleanup();
    }
  });

  it('data-from/to 指向 wikilink 节点本身，点击才能查到节点', () => {
    // 嵌入的装饰区间从 `!` 开始，但浮层按**节点**区间精确匹配
    // （`findInlineNodeAtRange` 比的是 from 与 to 都相等）。多带一个 `!` 就永远查不到，
    // 症状是点击被 preventDefault 吞掉、什么都不发生。
    const source = 'x ![[pic.png]] y';
    const mounted = mountVisual(source, 'embed-data-range', DOC_DIR);

    try {
      const span = mounted.parent.querySelector('.cm-visual-image') as HTMLElement;
      const wikiFrom = source.indexOf('[[');
      expect(Number(span.dataset.from)).toBe(wikiFrom);
      expect(Number(span.dataset.to)).toBe(source.indexOf(']]') + 2);
      expect(span.classList.contains('cm-visual-image-embed')).toBe(true);
    } finally {
      mounted.cleanup();
    }
  });

  it('目标不是图片时退回链接 widget，不渲染成坏图标', () => {
    // Obsidian 的 `![[某篇笔记]]` 是笔记嵌入，我们没有这个能力。
    // 当图片渲染会得到一个坏图标 —— 比一个可点的链接更糟。
    const mounted = mountVisual('![[另一篇笔记]]\n\n![[附录.md]]', 'embed-non-image', DOC_DIR);

    try {
      expect(mounted.parent.querySelector('.cm-visual-image')).toBeNull();
      expect(mounted.parent.querySelectorAll('.cm-visual-wikilink')).toHaveLength(2);
    } finally {
      mounted.cleanup();
    }
  });

  it('Ctrl+点击嵌入把目标名按 wikilink 递给宿主', () => {
    // 嵌入渲染成图片之后，导航选择器如果没跟着加上 `cm-visual-image-embed`，
    // Ctrl+点击会**静默失效** —— 导航按选择器命中元素，命不中就什么都不做、也不报错。
    const requests: LinkNavigationRequest[] = [];
    const mounted = mountVisual('![[assets/pic.png]]', 'embed-nav', DOC_DIR, (request) => {
      requests.push(request);
      return true;
    });

    try {
      const span = mounted.parent.querySelector('.cm-visual-image-embed') as HTMLElement;
      expect(span).not.toBeNull();

      span.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true
        })
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]!.href).toBe('assets/pic.png');
      expect(requests[0]!.kind).toBe('wikilink');
    } finally {
      mounted.cleanup();
    }
  });
});
