// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentTypeForPath,
  type IndexedDocument,
  type WorkspaceDirectoryEntry
} from '@nexus/core';
import { WorkspaceSidebar } from '../src/workspace/WorkspaceSidebar.js';
import { FileRowIcon, fileRowIcon } from '../src/components/workspace-icons.js';
import { localeManager } from '../src/platform.js';

/**
 * 工作区侧栏的**单树 + 工具栏**渲染（2026-10-01）。
 *
 * 为什么这一层要有用例：树的结构、空态的三种分支、工具栏按钮的可用矩阵都是
 * **组件里的分支**，纯函数（`tree.test.ts` / `tree-filter.test.ts`）测不到；
 * 而真机用例一个文件只能启动一次 Electron、只跑一种工作区形状，覆盖不到这些分支。
 *
 * 所以这里用**打桩的 `window.nexus`** 把 IPC 换掉，只验渲染：快、能造任意输入形状。
 * 真机那一层负责证明「真实索引与真实目录列举喂进来也是这个结果」。
 *
 * `apps/desktop/test/**` 与 `renderer/test/**` 都不进 typecheck，所以这里的类型只靠
 * esbuild 转译 —— 写错了不会有人告诉你，注意别依赖编译器。
 */

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只关心路径与类型，其余给固定值。 */
function doc(relativePath: string, overrides: Partial<IndexedDocument> = {}): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none',
    ...overrides
  };
}

function dir(relativePath: string): WorkspaceDirectoryEntry {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { path: `/vault/${relativePath}`, relativePath, name };
}

const OK_RESULT = {
  scanned: 0,
  indexed: 0,
  skipped: 0,
  removed: 0,
  extracted: 0,
  truncated: false,
  errors: [] as string[]
};

interface RenderOptions {
  documents?: IndexedDocument[];
  directories?: WorkspaceDirectoryEntry[];
  showImages?: boolean;
  rebuildFails?: boolean;
  /** 主进程报回来的「没处理成」清单。非空时侧栏要出一条可关闭的警告。 */
  indexErrors?: string[];
}

describe('工作区侧栏：单树 + 工具栏', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: {
    onOpenFile: ReturnType<typeof vi.fn>;
    onNodeContextMenu: ReturnType<typeof vi.fn>;
    onShowImagesChange: ReturnType<typeof vi.fn>;
    onCreateFile: ReturnType<typeof vi.fn>;
    onCreateFolder: ReturnType<typeof vi.fn>;
    onDeleteFile: ReturnType<typeof vi.fn>;
    onRefresh: ReturnType<typeof vi.fn>;
    onRevealHandled: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    currentReveal = null;
    props = {
      onOpenFile: vi.fn(),
      onNodeContextMenu: vi.fn(),
      onShowImagesChange: vi.fn(),
      onCreateFile: vi.fn(async () => '/vault/b.md'),
      onCreateFolder: vi.fn(async () => '/vault/素材'),
      onDeleteFile: vi.fn(),
      // 契约是「返回这一轮的失败清单」，不是 void —— 侧栏拿它换掉警告条上的旧数据。
      // 返回 `undefined` 的话刷新一次就会把清单清成 undefined，正是这条契约要挡的事。
      onRefresh: vi.fn(async () => []),
      // 与 `App` 里那一个同形：把请求清掉，下次渲染组件看到的才是「没有请求」。
      onRevealHandled: vi.fn(() => {
        currentReveal = null;
      })
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件里改过 locale 的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  /**
   * 渲染并等 effect 里的索引链跑完。
   *
   * 组件里的 effect 是 `void (async () => { await rebuildIndex(); await list() })()` ——
   * React 不会等它，所以 `await act(...)` 之后还要把微任务队列放干。
   *
   * 判据用 `data-phase="ready"` 而不是「有没有 `.nexus-sidebar-note`」：
   * **加载态也是 `.nexus-sidebar-note`**，按它等会在 `indexing` 就提前返回，
   * 断言随后失败、看起来却像「渲染错了」。
   */
  let currentOptions: RenderOptions = {};
  let currentRevision = 0;
  /**
   * 当前的「定位请求」。
   *
   * 组件只负责**兑现并回调**，清空是 `App` 的事（它拿 state 装着）—— 所以这里也照做：
   * 回调把它置 `null`，下一次重渲染时组件看到的才是「没有请求」。
   */
  let currentReveal: { path: string } | null = null;

  const renderElement = () => (
    <WorkspaceSidebar
      rootPath="/vault"
      activeFilePath={null}
      showImages={currentOptions.showImages ?? true}
      revision={currentRevision}
      revealRequest={currentReveal}
      {...props}
    />
  );

  async function renderSidebar(options: RenderOptions = {}): Promise<void> {
    currentOptions = options;
    const documents = options.documents ?? [];
    const directories = options.directories ?? [];

    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => {
        if (options.rebuildFails) throw new Error('索引库被占用');
        return { ...OK_RESULT, scanned: documents.length, errors: options.indexErrors ?? [] };
      }),
      // **每次返回一份新数组**，不是同一个引用 —— 跨 IPC 过来的本来就是新对象。
      // 返回同一引用的话 `setDocuments(同一个数组)` 会被 React 的 `Object.is`
      // 判定成「没变」而不重渲染，用例里「建完再重读」那一步就静默失效了。
      // 用例往自己的数组里 push 一条再 bump 版本号，等价于真实链路里
      // 「App 建完文件 → 主进程写索引 → bump revision」。
      listIndexedDocuments: vi.fn(async () => [...documents]),
      listWorkspaceDirectories: vi.fn(async () => [...directories])
    };

    await act(async () => {
      root.render(renderElement());
    });

    const settled = () => {
      const phase = container
        .querySelector('.nexus-workspace-sidebar')
        ?.getAttribute('data-phase');
      return phase === 'ready' || phase === 'error';
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (settled()) return;
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error(`侧栏没有进入 ready/error：${container.innerHTML}`);
  }

  /**
   * 模拟 `App` bump `documentRevision` 之后的那次重渲染。
   *
   * 侧栏只在 `revision` **变化**时重读列表（挂载那一次已经读过，跳过首跑避免竞态），
   * 所以这里必须真的换一个值、真的重渲染 —— 直接调 `renderSidebar` 是重新挂载，
   * 走的不是同一条路。
   */
  async function bumpRevision(): Promise<void> {
    currentRevision += 1;
    await act(async () => {
      root.render(renderElement());
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /**
   * 往受控输入框里打字。
   *
   * **必须走原生 setter**：React 18 在 input 元素上挂了一个 value 跟踪器，
   * 直接 `input.value = x` 会让 React 认为「值没变」而丢掉这次 change 事件 ——
   * 症状是 `onChange` 不触发、`draft` 一直是初值，看起来却像「校验没生效」。
   * 这是 happy-dom + 受控组件的老坑，与 `InlineRename` 的既有用例同源。
   */
  const typeInto = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const pressEnter = async (input: HTMLInputElement) => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const rows = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-relative-path]')).map((row) => ({
      kind: row.getAttribute('data-tree-kind'),
      relativePath: row.getAttribute('data-relative-path'),
      path: row.getAttribute('data-path'),
      attachment: row.getAttribute('data-attachment'),
      selected: row.getAttribute('data-selected') === 'true'
    }));

  const toolbarButton = (action: string) =>
    container.querySelector<HTMLButtonElement>(`.nexus-toolbar-button[data-action="${action}"]`);

  /**
   * 文件行图标的两个判据：类型（`data-file-kind`）与图形本身。
   *
   * 图形取 SVG 的 `innerHTML` 而不是让每枚图标自报一个 `data-icon` —— 要断言的是
   * **四类的图形真的不一样**，而自报的名字是答案的一部分：两枚图标画成同一个样子
   * 却各报各的名字，那样测照样绿。
   */
  const rowFileKind = (relativePath: string) =>
    container.querySelector(`[data-relative-path="${relativePath}"]`)?.getAttribute('data-file-kind');

  const rowIconMarkup = (relativePath: string) =>
    container.querySelector(`[data-relative-path="${relativePath}"] .nexus-tree-row-icon svg`)
      ?.innerHTML ?? null;

  const click = async (selector: string) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const rightClick = async (selector: string) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }));
    });
  };

  /**
   * 给「定位」用的那一对几何：树容器与目标行。
   *
   * happy-dom 不做布局 —— 所有 `getBoundingClientRect` 都是零矩形，`scrollTop` 也会被
   * 夹进 `[0, scrollHeight - clientHeight]` ＝ `[0, 0]`。不铺这一层，
   * 手算滚动那几行永远算出「没越界」，用例会绿得毫无意义。
   *
   * **前提是目标行已经在 DOM 里**（调用方先手动展开），否则拿不到那个元素。
   * 返回读当前 `scrollTop` 的函数 —— 断言要的是「滚了多少」，不是「滚过没有」。
   */
  const stubRevealGeometry = (
    targetRelativePath: string,
    geometry: { viewTop: number; viewBottom: number; rowTop: number; rowBottom: number },
    initialScrollTop = 0
  ): (() => number) => {
    const scroller = container.querySelector<HTMLElement>('.nexus-tree-scroll')!;
    const row = container.querySelector<HTMLElement>(
      `[data-relative-path="${targetRelativePath}"]`
    )!;

    const box = (top: number, bottom: number): DOMRect =>
      ({
        top,
        bottom,
        height: bottom - top,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({})
      }) as DOMRect;

    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => box(geometry.viewTop, geometry.viewBottom)
    });
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => box(geometry.rowTop, geometry.rowBottom)
    });

    let scrollTop = initialScrollTop;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    });

    return () => scrollTop;
  };

  /** 发一次定位请求并等滚动落地（滚动在 `requestAnimationFrame` 里）。 */
  const reveal = async (path: string) => {
    currentReveal = { path };
    await act(async () => {
      root.render(renderElement());
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };

  describe('单树', () => {
    it('笔记与附件在**同一棵树**里，按目录结构混排', async () => {
      await renderSidebar({
        documents: [doc('root.md'), doc('notes/dma.md'), doc('assets/logo.png')],
        directories: [dir('notes'), dir('assets')]
      });

      expect(rows().map((row) => row.relativePath)).toEqual([
        'assets',
        'assets/logo.png',
        'notes',
        'notes/dma.md',
        'root.md'
      ]);
      // 附件仍然被标出来 —— 图标与「显示附件」开关都靠这个属性
      expect(rows().find((row) => row.relativePath === 'assets/logo.png')?.attachment).toBe('true');
      expect(rows().find((row) => row.relativePath === 'notes/dma.md')?.attachment).toBe('false');
    });

    it('空目录也渲染 —— 索引里没有它，它来自磁盘列举', async () => {
      await renderSidebar({ documents: [], directories: [dir('素材')] });

      expect(rows().map((row) => row.relativePath)).toEqual(['素材']);
      expect(rows()[0]!.kind).toBe('directory');
      expect(rows()[0]!.path).toBe('/vault/素材');
    });

    it('点目录只展开/折叠，不开文件', async () => {
      await renderSidebar({
        documents: [doc('notes/deep/a.md')],
        directories: [dir('notes'), dir('notes/deep')]
      });

      // 默认只展开顶层：`notes` 开着、`notes/deep` 收着
      expect(rows().map((row) => row.relativePath)).not.toContain('notes/deep/a.md');

      await click('[data-relative-path="notes/deep"]');

      expect(rows().map((row) => row.relativePath)).toContain('notes/deep/a.md');
      expect(props.onOpenFile).not.toHaveBeenCalled();
    });

    it('点文件开它', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('[data-relative-path="a.md"]');

      expect(props.onOpenFile).toHaveBeenCalledWith('/vault/a.md');
    });
  });

  describe('显示图片开关', () => {
    it('树里没有图片时**不渲染**开关 —— 恒亮但没作用的按钮会让人怀疑它坏了', async () => {
      await renderSidebar({ documents: [doc('a.md'), doc('手册.pdf')], directories: [] });

      expect(toolbarButton('toggle-images')).toBeNull();
    });

    it('有图片时渲染，且报告当前是开还是关', async () => {
      await renderSidebar({
        documents: [doc('a.md'), doc('logo.png')],
        directories: [],
        showImages: true
      });

      const toggle = toolbarButton('toggle-images');
      expect(toggle?.getAttribute('data-shown')).toBe('true');
    });

    it('点它上报**取反**后的值（组件不自己改状态，那是 App 的事）', async () => {
      await renderSidebar({ documents: [doc('a.md'), doc('logo.png')], directories: [] });

      await click('.nexus-toolbar-button[data-action="toggle-images"]');

      expect(props.onShowImagesChange).toHaveBeenCalledWith(false);
    });

    it('关掉之后图片从树里消失，**PDF / DOCX 留着**，只含图片的目录一起消失', async () => {
      await renderSidebar({
        documents: [doc('a.md'), doc('assets/logo.png'), doc('手册.pdf')],
        directories: [dir('assets')],
        showImages: false
      });

      // 这条是这一栏最要紧的判据：藏的是图片，不是全部附件。
      // 用 `arrayContaining` 而不是逐位比 —— 中英混排的先后跟着运行时 locale 走
      // （本机 zh-CN 下汉字排在拉丁字母前），断言顺序等于断言这台机器的 ICU。
      expect(rows().map((row) => row.relativePath)).toEqual(
        expect.arrayContaining(['a.md', '手册.pdf'])
      );
      expect(rows()).toHaveLength(2);
    });

    it('**被过滤空**时给一条出路，而不是让用户面对一棵空树', async () => {
      await renderSidebar({
        documents: [doc('logo.png')],
        directories: [],
        showImages: false
      });

      expect(rows()).toEqual([]);
      const action = container.querySelector('[data-action="show-all"]');
      expect(action).not.toBeNull();

      await click('[data-action="show-all"]');
      expect(props.onShowImagesChange).toHaveBeenCalledWith(true);
    });
  });

  describe('工具栏的可用性', () => {
    it('没选中任何行时删除是禁用的，且 title 说明原因', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      const button = toolbarButton('delete');
      expect(button?.disabled).toBe(true);
      expect(button?.getAttribute('title')).toContain('Select a file');
    });

    it('选中文件后删除可用', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('[data-relative-path="a.md"]');

      expect(toolbarButton('delete')?.disabled).toBe(false);
      expect(rows().find((row) => row.relativePath === 'a.md')?.selected).toBe(true);
    });

    it('选中**目录**时删除仍然禁用，title 换成「暂不支持删除文件夹」', async () => {
      await renderSidebar({ documents: [], directories: [dir('notes')] });

      await click('[data-relative-path="notes"]');

      const button = toolbarButton('delete');
      expect(button?.disabled).toBe(true);
      expect(button?.getAttribute('title')).toContain('Folders cannot be deleted');
    });

    it('删除作用在**选中项**上，不是当前打开的文档', async () => {
      await renderSidebar({ documents: [doc('a.md'), doc('b.md')], directories: [] });

      await click('[data-relative-path="b.md"]');
      await click('.nexus-toolbar-button[data-action="delete"]');

      expect(props.onDeleteFile).toHaveBeenCalledWith('/vault/b.md');
    });

    it('点刷新上报，且刷新期间按钮禁用（防连点触发两次索引）', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="refresh"]');

      expect(props.onRefresh).toHaveBeenCalled();
    });
  });

  describe('一键展开 / 收起', () => {
    it('树里没有目录时不渲染那枚按钮 —— 按下去也没有东西可展开', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      expect(toolbarButton('toggle-expand')).toBeNull();
    });

    it('默认只有顶层展开，所以按钮显示「全部展开」', async () => {
      await renderSidebar({
        documents: [doc('a/b/c.md'), doc('top.md')],
        directories: [dir('a'), dir('a/b')]
      });

      // 顶层 `a` 开着（所以 `a/b` 这一行看得见），但 `a/b` 自己是收着的 ——
      // 它下面的 `a/b/c.md` 不在树里。
      expect(rows().map((row) => row.relativePath)).toEqual(['a', 'a/b', 'top.md']);
      expect(toolbarButton('toggle-expand')?.getAttribute('data-expanded')).toBe('false');
    });

    it('点一下全部展开，再点一下全部收起', async () => {
      await renderSidebar({
        documents: [doc('a/b/c.md'), doc('top.md')],
        directories: [dir('a'), dir('a/b')]
      });

      await click('.nexus-toolbar-button[data-action="toggle-expand"]');

      expect(rows().map((row) => row.relativePath)).toEqual([
        'a',
        'a/b',
        'a/b/c.md',
        'top.md'
      ]);
      // 全展开了 → 按钮换成「全部收起」
      expect(toolbarButton('toggle-expand')?.getAttribute('data-expanded')).toBe('true');

      await click('.nexus-toolbar-button[data-action="toggle-expand"]');

      // 收起之后只剩顶层那一层
      expect(rows().map((row) => row.relativePath)).toEqual(['a', 'top.md']);
      expect(toolbarButton('toggle-expand')?.getAttribute('data-expanded')).toBe('false');
    });

    it('「全部收起」管的是**整棵树**，被图片开关藏起来的目录也一起收', async () => {
      await renderSidebar({
        documents: [doc('a.md'), doc('assets/logo.png')],
        directories: [dir('assets')],
        showImages: false
      });

      // 此刻 `assets/` 不在可见树里，但它仍然是树里的一层
      expect(rows().map((row) => row.relativePath)).toEqual(['a.md']);
      await click('.nexus-toolbar-button[data-action="toggle-expand"]');

      // 把图片放出来：`assets/` 回来了，而且**是收着的**
      // —— 按可见树算的话它会是展开的，而用户刚才明明按了「全部收起」。
      currentOptions = { ...currentOptions, showImages: true };
      await bumpRevision();

      const assets = container.querySelector<HTMLElement>('[data-relative-path="assets"]');
      expect(assets).not.toBeNull();
      expect(assets?.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('新建', () => {
    it('点「新建文件」在**工作区根**开一行输入框，初值是 `未命名.md`', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');

      const input = container.querySelector<HTMLInputElement>('.nexus-tree-new-input');
      expect(input?.value).toBe('Untitled.md');
    });

    it('选中目录后新建落在**那个目录**里', async () => {
      await renderSidebar({ documents: [], directories: [dir('notes')] });

      await click('[data-relative-path="notes"]');
      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, '周报.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      expect(props.onCreateFile).toHaveBeenCalledWith('/vault/notes', '周报.md');
    });

    it('选中**文件**后新建落在它所在的目录里', async () => {
      await renderSidebar({
        documents: [doc('notes/a.md')],
        directories: [dir('notes')]
      });

      await click('[data-relative-path="notes/a.md"]');
      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, 'b.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      expect(props.onCreateFile).toHaveBeenCalledWith('/vault/notes', 'b.md');
    });

    it('同级重名时标红、且 Enter **不提交**', async () => {
      await renderSidebar({ documents: [doc('周报.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, '周报.md');

      const input = container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!;
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(container.querySelector('.nexus-tree-new-error')?.textContent).toContain('周报.md');

      await pressEnter(input);
      expect(props.onCreateFile).not.toHaveBeenCalled();
    });

    it('没写扩展名时按 `.md` 算重名 —— 主进程会补扩展名，不补就漏报', async () => {
      await renderSidebar({ documents: [doc('周报.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, '周报');

      expect(
        container.querySelector<HTMLInputElement>('.nexus-tree-new-input')?.getAttribute(
          'aria-invalid'
        )
      ).toBe('true');
    });

    it('新建失败时输入行**留着** —— 用户刚敲的名字还在，改一下就能重试', async () => {
      props.onCreateFile = vi.fn(async () => null);
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, 'b.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      expect(container.querySelector('.nexus-tree-new-input')).not.toBeNull();
    });

    it('新建成功后输入行收起', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');

      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, 'b.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      expect(container.querySelector('.nexus-tree-new-input')).toBeNull();
    });

    it('新建成功后**选中项挪到新节点**上 —— 否则「删除」会打在上一个选中的文件上', async () => {
      // 新建前先选中另一个文件，模拟「用户先点了 a.md，再建 b.md」
      const documents = [doc('a.md')];
      props.onCreateFile = vi.fn(async () => '/vault/b.md');
      await renderSidebar({ documents, directories: [] });

      await click('[data-relative-path="a.md"]');
      expect(rows().find((row) => row.relativePath === 'a.md')?.selected).toBe(true);

      await click('.nexus-toolbar-button[data-action="new-file"]');
      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, 'b.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      // 真实链路里新文件是主进程写的索引，侧栏靠 revision 重读才看见它
      documents.push(doc('b.md'));
      await bumpRevision();

      // 选中项跟着挪走了，而不是留在 a.md 上
      expect(rows().find((row) => row.relativePath === 'b.md')?.selected).toBe(true);
      expect(rows().find((row) => row.relativePath === 'a.md')?.selected).toBe(false);

      // 这条才是它防的事：此时点删除，删的必须是 b.md
      await click('.nexus-toolbar-button[data-action="delete"]');
      expect(props.onDeleteFile).toHaveBeenCalledWith('/vault/b.md');
    });

    it('树**先**更新、选中请求后到时，选中也要挪过去', async () => {
      // 上一条走的是「请求先到、树后更新」；这一条走**反过来的那一半**，而它才是真实顺序：
      // `createEntry` 是「先 bump 版本号让列表重读 → 再 await 打开文件 → 最后才返回路径」，
      // 所以新路径常常在树已经更新完之后才交回来。
      //
      // 用挂起的 promise 把这个顺序钉死：请求不 resolve，树先更新；再放行请求。
      const gate: { release: ((path: string | null) => void) | null } = { release: null };
      props.onCreateFile = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            gate.release = resolve;
          })
      );

      const documents = [doc('a.md')];
      await renderSidebar({ documents, directories: [] });

      await click('[data-relative-path="a.md"]');
      await click('.nexus-toolbar-button[data-action="new-file"]');
      await typeInto(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!, 'b.md');
      await pressEnter(container.querySelector<HTMLInputElement>('.nexus-tree-new-input')!);

      // 树先更新：新文件已经进列表，而 `onCreateFile` 还挂着没 resolve。
      documents.push(doc('b.md'));
      await bumpRevision();

      await act(async () => {
        gate.release?.('/vault/b.md');
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(rows().find((row) => row.relativePath === 'b.md')?.selected).toBe(true);
      expect(rows().find((row) => row.relativePath === 'a.md')?.selected).toBe(false);

      // 后果与上一条相同：此时点删除，删的必须是 b.md
      await click('.nexus-toolbar-button[data-action="delete"]');
      expect(props.onDeleteFile).toHaveBeenCalledWith('/vault/b.md');
    });

    it('Escape 取消，什么都不提交', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await click('.nexus-toolbar-button[data-action="new-file"]');
      await act(async () => {
        container
          .querySelector('.nexus-tree-new-input')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(container.querySelector('.nexus-tree-new-input')).toBeNull();
      expect(props.onCreateFile).not.toHaveBeenCalled();
    });
  });

  describe('空态与错误态', () => {
    it('工作区什么都没有时给「新建第一个文件」，不是一句死文案', async () => {
      await renderSidebar({ documents: [], directories: [] });

      expect(container.querySelector('[data-action="empty-create"]')).not.toBeNull();
      // 工具栏仍然在 —— 否则用户没有任何入口
      expect(toolbarButton('new-file')).not.toBeNull();
    });

    it('索引失败时给「重试」，且工具栏仍然可用', async () => {
      await renderSidebar({ rebuildFails: true });

      expect(container.querySelector('.nexus-workspace-sidebar')?.getAttribute('data-phase')).toBe(
        'error'
      );
      expect(container.querySelector('[data-action="retry"]')).not.toBeNull();
      expect(toolbarButton('new-file')).not.toBeNull();
    });
  });

  describe('右键与选中', () => {
    it('右键文件上报节点与坐标', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await rightClick('[data-relative-path="a.md"]');

      expect(props.onNodeContextMenu).toHaveBeenCalledTimes(1);
      const [node, x, y] = props.onNodeContextMenu.mock.calls[0]!;
      expect(node.relativePath).toBe('a.md');
      expect([x, y]).toEqual([10, 20]);
    });

    it('右键也会把它设成选中 —— 否则菜单里的动作与高亮会对不上', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await rightClick('[data-relative-path="a.md"]');

      expect(rows().find((row) => row.relativePath === 'a.md')?.selected).toBe(true);
    });

    it('右键目录上报的是目录节点（菜单要按它分叉）', async () => {
      await renderSidebar({ documents: [], directories: [dir('notes')] });

      await rightClick('[data-relative-path="notes"]');

      expect(props.onNodeContextMenu.mock.calls[0]![0].type).toBe('directory');
    });
  });

  describe('文件行的图标', () => {
    const ICON_FILES = ['a.md', 'b.pdf', 'c.docx', 'd.png'] as const;

    it('按类型各画一枚，且四枚互不相同', async () => {
      await renderSidebar({ documents: ICON_FILES.map((path) => doc(path)) });

      expect(ICON_FILES.map(rowFileKind)).toEqual(['markdown', 'pdf', 'docx', 'image']);

      const markups = ICON_FILES.map(rowIconMarkup);
      for (const markup of markups) expect(markup).toBeTruthy();
      // 这一条守的正是「图片和 PDF 长得一样」那个问题：四类共用一枚图标时这里只有 1 个。
      expect(new Set(markups).size).toBe(ICON_FILES.length);
    });

    it('索引里没有它的类型时落到通用图标', () => {
      // `FileTreeNode.document` 的类型允许 `null`（目录节点就是），所以这档兜底要留着；
      // 但它**造不出来** —— 树里的文件节点一定有文档（`buildFileTree` 从索引建），
      // 所以只能在函数这一层验。
      expect(fileRowIcon(null)).toBe(FileRowIcon);
      expect(fileRowIcon(undefined)).toBe(FileRowIcon);
    });
  });

  describe('定位到文件', () => {
    const nested = {
      documents: [doc('a/b/c.md'), doc('top.md')],
      directories: [dir('a'), dir('a/b')]
    };

    it('展开**每一层**祖先 —— 只展开直接父目录的话那一行仍然不在 DOM 里', async () => {
      await renderSidebar(nested);
      // 默认只展开顶层：`a` 开着、`a/b` 收着，所以目标行还不存在
      expect(rows().map((row) => row.relativePath)).toEqual(['a', 'a/b', 'top.md']);

      await reveal('/vault/a/b/c.md');

      expect(rows().map((row) => row.relativePath)).toContain('a/b/c.md');
      expect(container.querySelector('[data-relative-path="a"]')?.getAttribute('aria-expanded')).toBe(
        'true'
      );
      expect(
        container.querySelector('[data-relative-path="a/b"]')?.getAttribute('aria-expanded')
      ).toBe('true');
    });

    it('把目标行设为**选中**，并回调清掉请求', async () => {
      await renderSidebar(nested);

      await reveal('/vault/a/b/c.md');

      // 选中而不是只高亮：定位的下一步常常是「在这个文件上做点什么」（删除、重命名）
      expect(rows().find((row) => row.relativePath === 'a/b/c.md')?.selected).toBe(true);
      // 清掉才不会在下次树刷新时又跳一次
      expect(props.onRevealHandled).toHaveBeenCalledTimes(1);
    });

    it('在视野**下方**时按最小距离上滚（只对齐到边界，不顶到正中）', async () => {
      await renderSidebar(nested);
      await click('[data-relative-path="a/b"]');
      // 容器可视区是 0..200，目标行在 500..520 ⇒ 差 320
      const readScrollTop = stubRevealGeometry('a/b/c.md', {
        viewTop: 0,
        viewBottom: 200,
        rowTop: 500,
        rowBottom: 520
      });

      await reveal('/vault/a/b/c.md');

      expect(readScrollTop()).toBe(320);
    });

    it('在视野**上方**时往回滚', async () => {
      await renderSidebar(nested);
      await click('[data-relative-path="a/b"]');
      // 树已经滚到 500，目标行落在可视区**上边界之外**（负的 top 就是「在视野上方」）
      // ⇒ 往回 100
      const readScrollTop = stubRevealGeometry(
        'a/b/c.md',
        { viewTop: 0, viewBottom: 200, rowTop: -100, rowBottom: -80 },
        500
      );

      await reveal('/vault/a/b/c.md');

      expect(readScrollTop()).toBe(400);
    });

    it('**已经在视野里时一动不动** —— 否则每次定位都会把树莫名挪一下', async () => {
      await renderSidebar(nested);
      await click('[data-relative-path="a/b"]');
      const readScrollTop = stubRevealGeometry('a/b/c.md', {
        viewTop: 0,
        viewBottom: 200,
        rowTop: 50,
        rowBottom: 70
      });

      await reveal('/vault/a/b/c.md');

      expect(readScrollTop()).toBe(0);
    });

    it('找不到目标时**保持挂起**、不报错 —— 索引还没跑完就会这样', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });

      await reveal('/vault/nowhere.md');

      // 不清请求：树每更新一次就重试一次，索引跑完自然会成功。
      // 反过来（当场放弃）会让「刚开完工作区就定位」永远差一拍。
      expect(props.onRevealHandled).not.toHaveBeenCalled();
      expect(rows().map((row) => row.relativePath)).toEqual(['a.md']);
    });
  });

  /**
   * 「有 N 个文件没能建索引」。
   *
   * 这一条要同时钉住三件事，缺一个都会退化成「用户以为一切正常」：
   * ① 清单非空时**真的画出来**（原来是 `console.warn`，界面上完全不存在）；
   * ② 件数是主进程给的，不是渲染进程自己数的；
   * ③ 明细在 tooltip 里 —— 条上只说件数，因为一条坏路径的报错消息可能很长。
   *
   * 反面同样重要：没有失败时**一条都不能有**。判据要是写成「有 errors 字段就画」，
   * 每个正常的工作区顶上都会常驻一条警告。
   */
  describe('部分文件没能建索引', () => {
    const warning = () =>
      container.querySelector<HTMLElement>('[data-sidebar-warning="index-errors"]');

    it('主进程报了失败时画一条可关闭的警告，件数来自清单', async () => {
      await renderSidebar({
        documents: [doc('a.md')],
        directories: [],
        indexErrors: ['docs/坏.pdf: Unexpected end of PDF', 'notes/x.md: EACCES']
      });

      const banner = warning();
      expect(banner).not.toBeNull();
      // 件数是清单的长度，不是「画了一条」这种弱判据
      expect(banner?.textContent).toContain('2');
      // 明细走 title
      expect(banner?.getAttribute('title')).toContain('docs/坏.pdf');
      expect(banner?.getAttribute('title')).toContain('notes/x.md');

      // 树照常画 —— 这条与「整次索引失败」不是一回事，它不该把树顶掉
      expect(rows().map((row) => row.relativePath)).toEqual(['a.md']);
    });

    it('点「关闭」把条收掉 —— 它不阻塞任何操作，不该赖着不走', async () => {
      await renderSidebar({
        documents: [doc('a.md')],
        directories: [],
        indexErrors: ['docs/坏.pdf: boom']
      });
      expect(warning()).not.toBeNull();

      await click('[data-action="dismiss-index-errors"]');

      expect(warning()).toBeNull();
      expect(rows().map((row) => row.relativePath)).toEqual(['a.md']);
    });

    it('没有失败时一条都不画', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [], indexErrors: [] });

      expect(warning()).toBeNull();
    });

    /**
     * 工具栏那个「刷新」**也会重跑索引**，所以它必须把新清单交回来。
     *
     * 只让进入工作区那一次报失败、刷新之后不管，条就会一直挂着上一轮的旧数据 ——
     * 用户按了刷新、问题已经好了，条还在说「有 2 个文件没能建立索引」。
     * 两个方向都钉：先是「刷新之后才出现」，再是「刷新之后消失」。
     */
    it('刷新之后条跟着**这一轮**的结果走，不是挂着旧数据', async () => {
      await renderSidebar({ documents: [doc('a.md')], directories: [] });
      expect(warning()).toBeNull();

      props.onRefresh.mockResolvedValueOnce(['docs/坏.pdf: boom', 'notes/x.md: EACCES']);
      await click('.nexus-toolbar-button[data-action="refresh"]');
      expect(warning()?.textContent).toContain('2');

      // 这一轮全好了 —— 条要消失，不能因为「曾经失败过」就一直留着
      props.onRefresh.mockResolvedValueOnce([]);
      await click('.nexus-toolbar-button[data-action="refresh"]');
      expect(warning()).toBeNull();
    });

    /**
     * 反面中的反面：整次索引失败时走的是 `.nexus-sidebar-error`（树画不出来），
     * 不是这一条。两条混用的话，「一条坏文件」和「整个工作区打不开」会长得一样。
     */
    it('整次索引失败时走错误态，不画这条警告', async () => {
      await renderSidebar({ documents: [], directories: [], rebuildFails: true });

      expect(warning()).toBeNull();
      expect(container.querySelector('.nexus-sidebar-error')).not.toBeNull();
    });
  });
});
