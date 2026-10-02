// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView, MarkdownDocumentSession } from '@nexus/editor';
import { OutlinePanel } from '../src/workspace/OutlinePanel.js';
import { localeManager, settings } from '../src/platform.js';

/**
 * 大纲面板的**折叠**渲染与交互。
 *
 * 为什么要有这一层：`outline-model.test.ts` 验的是「给定折叠集合，哪些项可见」，
 * 验不了「三角画在谁身上」「点三角会不会顺手触发跳转」「编辑文档后折叠状态还在不在」。
 * 真机用例一个文件只能造一种文档形状，铺不开这些分支。
 *
 * `apps/desktop/test/**` 与 `renderer/test/**` 都不进 typecheck，这里的类型只靠 esbuild
 * 转译 —— 写错了不会有人告诉你。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 只用到 `getSnapshot` / `subscribe` / `dispatch`；再给一个 `push` 让用例能模拟「文档被编辑」。
 *
 * `dispatch` 会**真的**把变更应用到 source 上（虽然真实 session 还要管 revision、history、
 * 选区映射）—— 否则「点了按钮之后大纲多出一项」这件事根本验不了。
 */
function fakeSession(source: string) {
  const listeners = new Set<(snapshot: { source: string }) => void>();
  const dispatched: unknown[] = [];
  let current = source;

  return {
    session: {
      getSnapshot: () => ({ source: current }),
      subscribe: (listener: (snapshot: { source: string }) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispatch: (transaction: {
        changes?: readonly { from: number; to: number; insert: string }[];
      }) => {
        dispatched.push(transaction);
        for (const change of transaction.changes ?? []) {
          current = current.slice(0, change.from) + change.insert + current.slice(change.to);
        }
        for (const listener of listeners) listener({ source: current });
        return { source: current, revision: 0, selection: { anchor: 0, head: 0 } };
      }
    } as unknown as MarkdownDocumentSession,
    dispatched,
    push(next: string) {
      current = next;
      for (const listener of listeners) listener({ source: next });
    }
  };
}

const DOC = ['# A', '## A1', '### A1a', '## A2', '# B'].join('\n');

/** `DOC` 里每个标题的源码偏移，用来算「光标在哪一节」。 */
const OFFSET = { A: 0, A1: 4, A1a: 10, A2: 18, B: 24 } as const;

/** 视口：屏幕 y 从 0 到 600。 */
const SCROLLER = { top: 0, bottom: 600, height: 600, left: 0, right: 800 };

/**
 * 只实现 `referencePosition` 与滚动监听会用到的那几项。
 *
 * `cursorTop` 给 `null` 表示「光标那一行不在 DOM 里」（视口虚拟化时真会这样）。
 */
function fakeView(
  head: number,
  options: { cursorTop?: number | null; midLineFrom?: number } = {}
): EditorView {
  const cursorTop = options.cursorTop === undefined ? 300 : options.cursorTop;

  return {
    state: { selection: { main: { head } } },
    scrollDOM: {
      getBoundingClientRect: () => SCROLLER,
      // 组件会在滚动容器上挂/摘监听，桩里得有这么一对方法
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    coordsAtPos: () =>
      cursorTop === null ? null : { top: cursorTop, bottom: cursorTop + 20 },
    lineBlockAtHeight: () => ({ from: options.midLineFrom ?? 0 }),
    documentTop: 0
  } as unknown as EditorView;
}

const rect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({})
  }) as DOMRect;

/** 面板视口固定为 0–100；高亮项的位置由 `activeTop` 控制，用例中间可以改。 */
let activeTop = 0;

function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const element = this as HTMLElement;
    if (element.classList?.contains('nexus-sidebar-list')) return rect(0, 100);
    if (element.dataset?.active === 'true') return rect(activeTop, activeTop + 20);
    return rect(0, 0);
  });
}

describe('大纲面板：折叠', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onJump: ReturnType<typeof vi.fn>;
  let onOpenFile: ReturnType<typeof vi.fn>;
  let stub: ReturnType<typeof fakeSession>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onJump = vi.fn();
    onOpenFile = vi.fn();
    activeTop = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    // 反向链接那组用例会打桩 `window.nexus`；不清掉的话它会跟着进程活到下一个用例
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件改过 locale 与设置项的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
      settings.set('editor.outlineLevel', 'all');
    });
    vi.restoreAllMocks();
  });

  const render = (
    source = DOC,
    options: { view?: EditorView | null; cursorOffset?: number; filePath?: string | null } = {}
  ) => {
    stub = fakeSession(source);
    act(() => {
      root.render(
        <OutlinePanel
          session={stub.session}
          onJump={onJump}
          filePath={options.filePath ?? null}
          onOpenFile={onOpenFile}
          view={options.view ?? null}
          cursorOffset={options.cursorOffset ?? 0}
        />
      );
    });
  };

  const titles = () =>
    Array.from(container.querySelectorAll('.nexus-outline-item')).map((el) => el.textContent);
  const toggleButtons = () =>
    Array.from(container.querySelectorAll<HTMLElement>('button.nexus-outline-toggle'));
  const placeholders = () =>
    Array.from(container.querySelectorAll<HTMLElement>('span.nexus-outline-toggle'));
  const activeTitle = () =>
    container.querySelector('.nexus-outline-item[data-active="true"]')?.textContent ?? null;

  const clickToggle = (index: number) => {
    act(() => {
      toggleButtons()[index]!.click();
    });
  };

  it('列出全部标题', () => {
    render();
    expect(titles()).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
  });

  it('只有存在子项的标题才画折叠三角，其余用等宽占位符', () => {
    render();
    // A、A1 有子项；A1a、A2、B 没有。**正反两面都要断言** ——
    // 只数「有几个三角」对「三角画在每一个标题上」同样成立。
    expect(toggleButtons()).toHaveLength(2);
    expect(placeholders()).toHaveLength(3);

    // 占位符必须和三角一样宽，否则同级标题的左边界会差半个字符
    expect(placeholders()[0]!.className).toBe(toggleButtons()[0]!.className);
  });

  it('折叠一级标题会带走它的子孙，后面的同级标题还在', () => {
    render();
    clickToggle(0);
    expect(titles()).toEqual(['A', 'B']);
    // 折叠态写进 aria-expanded，键盘与读屏用的是同一个事实
    expect(toggleButtons()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(toggleButtons()[0]!.getAttribute('data-collapsed')).toBe('true');
  });

  it('再点一次展开，子孙原样回来', () => {
    render();
    clickToggle(0);
    clickToggle(0);
    expect(titles()).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(toggleButtons()[0]!.getAttribute('aria-expanded')).toBe('true');
  });

  it('折叠二级标题只带走它自己的子孙', () => {
    render();
    clickToggle(1);
    expect(titles()).toEqual(['A', 'A1', 'A2', 'B']);
  });

  it('点折叠三角**不会**触发跳转', () => {
    // 三角和标题是两个按钮，共用一个行容器 —— 事件没隔开的话点三角会顺带跳一次
    render();
    clickToggle(0);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('点标题仍然触发跳转', () => {
    render();
    act(() => {
      container.querySelectorAll<HTMLElement>('.nexus-outline-item')[1]!.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('编辑文档后折叠状态不错位（键里没有下标）', () => {
    render();
    clickToggle(0);
    expect(titles()).toEqual(['A', 'B']);

    // 在最前面插入一个新标题：所有项的下标都平移了
    act(() => {
      stub.push(`### 插进来的\n\n${DOC}`);
    });

    // 折着的仍然是 A，而不是「原来的第 0 项现在是谁」。
    // 「插进来的」后面跟的是 h1，层级不更深，所以它没有三角 —— 这时列表里唯一的三角
    // 就是 A 的，它必须仍是折叠态。
    expect(titles()).toEqual(['插进来的', 'A', 'B']);
    expect(toggleButtons()).toHaveLength(1);
    expect(toggleButtons()[0]!.getAttribute('data-collapsed')).toBe('true');
  });

  it('标题被删掉后，它的折叠状态不会转移到别的标题上', () => {
    render();
    clickToggle(0); // 折叠 A
    act(() => {
      stub.push('# B'); // 整篇只剩 B
    });
    expect(titles()).toEqual(['B']);
  });

  it('没有标题时显示空态，不画列表', () => {
    render('只有正文。');
    expect(titles()).toEqual([]);
    expect(container.querySelector('.nexus-sidebar-note')).not.toBeNull();
  });

  describe('当前所处的层级', () => {
    it('光标在视口内时，高亮光标所在的那一节', () => {
      render(DOC, { view: fakeView(OFFSET.A2, { cursorTop: 300 }), cursorOffset: OFFSET.A2 });
      expect(activeTitle()).toBe('A2');
    });

    it('光标滚出视口后，改用视口中线所在的标题', () => {
      // head 还在 A1，但那一行已经滚到视口上方看不见了 —— 这时按光标算会高亮 A1，
      // 而用户正在看 B
      render(DOC, {
        view: fakeView(OFFSET.A1, { cursorTop: -50, midLineFrom: OFFSET.B }),
        cursorOffset: OFFSET.A1
      });
      expect(activeTitle()).toBe('B');
    });

    it('光标那一行不在 DOM 里时（视口虚拟化），同样退到视口中线', () => {
      render(DOC, {
        view: fakeView(OFFSET.A1, { cursorTop: null, midLineFrom: OFFSET.A1a }),
        cursorOffset: OFFSET.A1
      });
      expect(activeTitle()).toBe('A1a');
    });

    it('没有 view 时退化成「只看光标」', () => {
      render(DOC, { view: null, cursorOffset: OFFSET.A1a });
      expect(activeTitle()).toBe('A1a');
    });

    it('光标在第一个标题之前时不高亮任何一项', () => {
      // 前言不属于任何一节 —— 硬指一个会让人以为自己在那一节里
      render('前言。\n\n# A', { view: fakeView(0, { cursorTop: 300 }), cursorOffset: 0 });
      expect(activeTitle()).toBeNull();
    });

    it('光标移动后高亮跟着走', () => {
      render(DOC, { view: fakeView(OFFSET.A, { cursorTop: 300 }), cursorOffset: OFFSET.A });
      expect(activeTitle()).toBe('A');

      render(DOC, { view: fakeView(OFFSET.B, { cursorTop: 300 }), cursorOffset: OFFSET.B });
      expect(activeTitle()).toBe('B');
    });

    it('被折叠藏起来的那一节不会高亮（它根本不在列表里）', () => {
      render(DOC, { view: fakeView(OFFSET.A1, { cursorTop: 300 }), cursorOffset: OFFSET.A1 });
      expect(activeTitle()).toBe('A1');

      clickToggle(0); // 折叠 A → A1 从列表里消失
      expect(activeTitle()).toBeNull();
    });
  });

  describe('把高亮项滚进面板自己的视口', () => {
    const list = () => container.querySelector<HTMLElement>('.nexus-sidebar-list')!;
    const highlight = (offset: number) =>
      render(DOC, { view: fakeView(offset, { cursorTop: 300 }), cursorOffset: offset });

    it('高亮项在面板下方时往下滚', () => {
      stubLayout();
      activeTop = 300; // 面板视口是 0–100，高亮项占 300–320
      highlight(OFFSET.B);

      expect(list().scrollTop).toBe(220); // 320（项底边）− 100（视口底边）
    });

    it('高亮项在面板上方时往回滚', () => {
      stubLayout();
      activeTop = 300;
      highlight(OFFSET.B);
      expect(list().scrollTop).toBe(220);

      activeTop = -50;
      highlight(OFFSET.A); // 换一项 → 参考位置变 → effect 重跑
      expect(list().scrollTop).toBe(170); // 220 − (0 − (−50))
    });

    it('高亮项已经在视口里时一动不动', () => {
      // 用户自己翻大纲不该被拽回去 —— 这条和上面两条一起，才是「nearest」的完整语义
      stubLayout();
      activeTop = 40; // 40–60，落在 0–100 里
      highlight(OFFSET.A);

      expect(list().scrollTop).toBe(0);
    });

    it('没有高亮项时不滚', () => {
      stubLayout();
      // 光标停在第一个标题之前 → 没有当前项
      render('前言。\n\n# A', { view: fakeView(0, { cursorTop: 300 }), cursorOffset: 0 });

      expect(list().scrollTop).toBe(0);
    });
  });

  describe('空态：添加标题', () => {
    const insertButton = () => container.querySelector<HTMLElement>('.nexus-outline-insert');

    it('空文档给出一条出路，而不是只有一句「还没有标题」', () => {
      render('只有正文。');
      expect(insertButton()).not.toBeNull();
    });

    it('有标题时不画这个按钮', () => {
      render();
      expect(insertButton()).toBeNull();
    });

    it('点击后在文首插入 #，并把光标放到它后面', () => {
      render('只有正文。');
      act(() => {
        insertButton()!.click();
      });

      // **选区是必须的**：不带的话光标留在原处，用户看到的就是「点了按钮什么都没发生」
      expect(stub.dispatched).toEqual([
        { changes: [{ from: 0, to: 0, insert: '# ' }], selection: { anchor: 2, head: 2 } }
      ]);
    });

    it('插入之后大纲里立刻有了这一项，空态让位', () => {
      render('只有正文。');
      act(() => {
        insertButton()!.click();
      });

      expect(titles()).toEqual(['只有正文。']);
      expect(insertButton()).toBeNull();
    });
  });

  describe('层级过滤（走设置项）', () => {
    const setLevel = (level: string) => {
      act(() => {
        settings.set('editor.outlineLevel', level);
      });
    };

    it('改成「只显示 2 级」后，3 级标题不再渲染', () => {
      render();
      expect(titles()).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);

      setLevel('2');
      expect(titles()).toEqual(['A', 'A1', 'A2', 'B']);
    });

    it('改回「全部层级」后原样回来', () => {
      setLevel('2');
      render();
      expect(titles()).toEqual(['A', 'A1', 'A2', 'B']);

      setLevel('all');
      expect(titles()).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    });

    it('过滤掉的子项不算「有子项」—— 否则会画一个点下去没反应的假三角', () => {
      setLevel('2');
      render();

      // `### A1a` 被滤掉，所以 A1 在 2 级视角下没有可见子孙，只剩 A 一个三角
      expect(toggleButtons()).toHaveLength(1);
      expect(placeholders()).toHaveLength(3);
    });

    it('默认是全部层级（与加这一项之前一致）', () => {
      render();
      expect(titles()).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    });
  });

  /**
   * 反向链接的**锚点**渲染。
   *
   * 为什么要这一层：主进程那条链（抽取 → 落库 → 查回来）由 `backlinks.test.ts` 与
   * `index-store.test.ts` 守着，但它们验不了「锚点到底画没画出来」。
   * 而这一块最容易出的错法是**静默的**：字段改名后锚点不显示了，页面上什么都不报。
   */
  describe('反向链接：锚点', () => {
    const documentOf = (relativePath: string, id: number) => ({
      id,
      path: `/vault/${relativePath}`,
      relativePath,
      name: relativePath.split('/').pop() ?? relativePath,
      title: relativePath,
      type: 'markdown',
      sizeBytes: 1,
      modifiedAtMs: 1,
      contentHash: relativePath,
      extractionStatus: 'none'
    });

    const backlinkItems = () =>
      Array.from(container.querySelectorAll<HTMLElement>('.nexus-backlink-item'));
    const anchors = () =>
      Array.from(container.querySelectorAll<HTMLElement>('.nexus-backlink-anchor')).map(
        (el) => el.textContent
      );

    const renderWithBacklinks = async (
      entries: Array<{ document: ReturnType<typeof documentOf>; anchor: string | null }>
    ) => {
      (window as unknown as { nexus: unknown }).nexus = {
        findBacklinks: vi.fn(async () => entries)
      };
      render(DOC, { filePath: '/vault/dma.md' });
      // 反向链接是异步查回来的，得让微任务跑完再断言
      await act(async () => {});
    };

    it('带锚点的引用把锚点画出来，不带的就不画', async () => {
      await renderWithBacklinks([
        { document: documentOf('index.md', 1), anchor: '性能' },
        { document: documentOf('plain.md', 2), anchor: null }
      ]);

      expect(backlinkItems().map((el) => el.textContent)).toEqual([
        'index.md性能',
        'plain.md'
      ]);
      // **正反两面**：只断言「有一个锚点」对「两条都画了同一个锚点」同样成立
      expect(anchors()).toEqual(['性能']);
    });

    it('锚点只作提示，点击仍然打开来源文档', async () => {
      await renderWithBacklinks([{ document: documentOf('index.md', 1), anchor: '性能' }]);

      act(() => {
        backlinkItems()[0]!.click();
      });
      expect(onOpenFile).toHaveBeenCalledWith('/vault/index.md');
    });

    it('没有反向链接时是空态，不画列表', async () => {
      await renderWithBacklinks([]);

      expect(backlinkItems()).toEqual([]);
      expect(container.querySelector('.nexus-backlinks .nexus-sidebar-note')).not.toBeNull();
    });
  });
});
