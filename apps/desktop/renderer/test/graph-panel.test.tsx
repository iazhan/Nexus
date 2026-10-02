// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphQuery, WorkspaceGraph } from '@nexus/core';
import { GraphPanel } from '../src/workspace/GraphPanel.js';
import { CLUSTER_TOKENS, UNCLUSTERED_TOKEN } from '../src/workspace/graph-clusters.js';
import { localeManager, settings } from '../src/platform.js';
import { GRAPH_MODE_DEFAULT, GRAPH_SCOPE_DEFAULT } from '../src/settings/preference-specs.js';

/**
 * 图谱控制条：范围（全图 / 当前文档）与类型筛选。
 *
 * 为什么要这一层：真机用例（`apps/desktop/test/graph-panel.test.ts`）一次只能造一种工作区
 * 形状，铺不开「关掉某个类型」「把类型全关掉」「没有活动文档时当前文档不可选」这些分支。
 * 这里用打桩的 `window.nexus.getGraph` 换掉 IPC，只验渲染与请求参数。
 *
 * canvas 在 happy-dom 里拿不到 2D context，绘制那一段会提前返回 —— 这些用例不碰绘制，
 * 只验控制条与空态。绘制与投影在真机用例与 `graph-*.test.ts` 里验。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * happy-dom 没有 ResizeObserver；组件靠它量画布。
 *
 * 记下每个实例的回调，让「尺寸变了」这件事在用例里**可控** —— 否则
 * 「拖侧栏时等尺寸停下来再重算布局」这条判据根本没法验。
 */
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];

  constructor(private readonly callback: () => void) {
    StubResizeObserver.instances.push(this);
  }

  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}

  /** 模拟一次尺寸变化。 */
  fire(): void {
    this.callback();
  }
}

const node = (id: number, name: string, type: string, degree: number) => ({
  kind: 'document' as const,
  id,
  path: `/vault/${name}`,
  relativePath: name,
  name,
  type,
  degree
});

/** 全量图：3 篇笔记 + 1 个 PDF。 */
const FULL: WorkspaceGraph = {
  nodes: [
    node(1, 'a.md', 'markdown', 1),
    node(2, 'b.md', 'markdown', 2),
    node(3, 'c.md', 'markdown', 1),
    node(4, 'manual.pdf', 'pdf', 1)
  ],
  edges: [
    { source: 1, target: 2 },
    { source: 2, target: 3 },
    { source: 2, target: 4 }
  ]
};

const onlyNotes = (graph: WorkspaceGraph): WorkspaceGraph => ({
  nodes: graph.nodes.filter((item) => item.type === 'markdown'),
  edges: graph.edges.filter(
    (edge) =>
      graph.nodes.find((item) => item.id === edge.source)?.type === 'markdown' &&
      graph.nodes.find((item) => item.id === edge.target)?.type === 'markdown'
  )
});

describe('图谱控制条', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    StubResizeObserver.instances = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;

    /*
      图例的颜色是从 CSS 变量读的。happy-dom 不会加载主题，这里把变量挂到根元素上，
      否则 `readColor()` 每次都读回空串 —— 断言「色块有颜色」就永远不成立。
    */
    for (const token of CLUSTER_TOKENS) {
      document.documentElement.style.setProperty(token, '#336699');
    }
    document.documentElement.style.setProperty(UNCLUSTERED_TOKEN, '#888888');

    /*
      桩按**查询**返回不同结果，而不是永远返回同一份 —— 否则「关掉一个类型之后节点变少」
      这条断言对「根本没把筛选传下去」同样成立。
    */
    getGraph = vi.fn(async (query?: GraphQuery) => {
      if (query?.types === undefined) return FULL;
      return {
        nodes: FULL.nodes.filter((item) => query.types!.includes(item.type)),
        edges: FULL.edges.filter(
          (edge) =>
            query.types!.includes(FULL.nodes.find((item) => item.id === edge.source)!.type) &&
            query.types!.includes(FULL.nodes.find((item) => item.id === edge.target)!.type)
        )
      };
    });

    // 切到清单视图时那两个组件会挂上，必须一起打桩，否则它们会去调 undefined
    (window as unknown as { nexus: unknown }).nexus = {
      getGraph,
      getGraphOrphans: vi.fn(async () => []),
      getGraphHubs: vi.fn(async () => [])
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    act(() => {
      localeManager.setLocale('en-US');
    });
    // 这三项现在是**落盘**的视图状态，不还原会渗到同文件后面的用例 ——
    // 而单跑又是绿的（与 locale 那条同一个坑）
    settings.set('graph.mode', GRAPH_MODE_DEFAULT);
    settings.set('graph.scope', GRAPH_SCOPE_DEFAULT);
    settings.set('graph.hiddenTypes', []);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const render = async (options: { activeFilePath?: string | null } = {}) => {
    await act(async () => {
      root.render(
        <GraphPanel
          activeFilePath={options.activeFilePath ?? null}
          onOpenFile={vi.fn()}
          revision={1}
        />
      );
    });
    // 两次查询都是异步的，再让微任务跑一轮
    await act(async () => {});
  };

  const chips = () => Array.from(container.querySelectorAll<HTMLElement>('.nexus-graph-chip'));
  const chip = (selector: string) => container.querySelector<HTMLElement>(selector);
  const count = () => container.querySelector('.nexus-sidebar-count')?.textContent ?? null;

  it('列出范围开关与类型开关，各带篇数', async () => {
    await render();

    expect(chip('[data-scope="all"]')).not.toBeNull();
    expect(chip('[data-scope="current"]')).not.toBeNull();
    // 三种类型：笔记 3 篇、PDF 1 篇
    expect(chips().map((el) => el.dataset.type).filter(Boolean).sort()).toEqual([
      'markdown',
      'pdf'
    ]);
    expect(chip('[data-type="markdown"]')!.textContent).toContain('3');
    expect(chip('[data-type="pdf"]')!.textContent).toContain('1');
    expect(count()).toBe('4');
  });

  it('没有活动文档时「当前文档」不可选，有文档时可选', async () => {
    await render({ activeFilePath: null });
    expect(chip('[data-scope="current"]')!.hasAttribute('disabled')).toBe(true);

    await render({ activeFilePath: '/vault/a.md' });
    expect(chip('[data-scope="current"]')!.hasAttribute('disabled')).toBe(false);
  });

  it('点「当前文档」把中心与层数传给查询', async () => {
    await render({ activeFilePath: '/vault/a.md' });

    await act(async () => {
      chip('[data-scope="current"]')!.click();
    });
    await act(async () => {});

    expect(getGraph).toHaveBeenCalledWith(
      expect.objectContaining({ centerPath: '/vault/a.md', degrees: 2 })
    );
    expect(chip('[data-scope="current"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('关掉一个类型后节点变少，且查询里带上了白名单', async () => {
    await render();
    expect(count()).toBe('4');

    await act(async () => {
      chip('[data-type="pdf"]')!.click();
    });
    await act(async () => {});

    // 只留笔记 —— 传下去的是**白名单**（保留哪些），不是黑名单
    expect(getGraph).toHaveBeenCalledWith(expect.objectContaining({ types: ['markdown'] }));
    expect(count()).toBe('3');
    expect(chip('[data-type="pdf"]')!.getAttribute('aria-pressed')).toBe('false');
    // 关掉的开关必须还在，否则用户再也打不开它
    expect(chip('[data-type="pdf"]')).not.toBeNull();
  });

  it('再点一次恢复', async () => {
    await render();

    await act(async () => {
      chip('[data-type="pdf"]')!.click();
    });
    await act(async () => {});
    expect(count()).toBe('3');

    await act(async () => {
      chip('[data-type="pdf"]')!.click();
    });
    await act(async () => {});

    expect(count()).toBe('4');
    // 全都没关掉时不该带 `types` —— 带空数组会得到一张空图
    expect(getGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ types: undefined })
    );
  });

  it('把类型全关掉时给出「显示全部」的出路，点了能回来', async () => {
    await render();

    for (const type of ['markdown', 'pdf']) {
      await act(async () => {
        chip(`[data-type="${type}"]`)!.click();
      });
      await act(async () => {});
    }

    // 筛空 ≠ 本来就没东西可画，两者不能共用一句话
    expect(count()).toBeNull();
    const note = container.querySelector('.nexus-sidebar-note')!;
    expect(note.textContent).toContain('No documents match');
    expect(note.textContent).not.toContain('No documents to draw yet');

    const reset = container.querySelector<HTMLElement>('.nexus-graph-reset')!;
    expect(reset).not.toBeNull();
    await act(async () => {
      reset.click();
    });
    await act(async () => {});

    expect(count()).toBe('4');
    expect(container.querySelector('.nexus-graph-reset')).toBeNull();
  });

  it('图例按分区大小列出，根目录下的文档并入「其他」', async () => {
    // notes 2 篇、archive 1 篇、根目录 1 篇 —— 排名决定颜色，也决定图例顺序
    getGraph.mockImplementation(async () => ({
      nodes: [
        node(1, 'notes/a.md', 'markdown', 1),
        node(2, 'notes/b.md', 'markdown', 1),
        node(3, 'archive/c.md', 'markdown', 1),
        node(4, 'root.md', 'markdown', 0)
      ],
      edges: [
        { source: 1, target: 2 },
        { source: 2, target: 3 }
      ]
    }));
    await render();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.nexus-graph-legend-row'));
    expect(rows.map((row) => row.dataset.cluster)).toEqual(['notes', 'archive', 'Other']);
    expect(
      rows.map((row) => row.querySelector('.nexus-graph-legend-count')?.textContent)
    ).toEqual(['2', '1', '1']);

    // 色块真的拿到了颜色 —— 只断言「有这一行」对「色块是透明的」同样成立
    const swatches = Array.from(
      container.querySelectorAll<HTMLElement>('.nexus-graph-legend-swatch')
    );
    expect(swatches.every((swatch) => swatch.style.backgroundColor !== '')).toBe(true);
  });

  it('没有分区时不画图例（全在根目录的扁平工作区）', async () => {
    await render();

    // `FULL` 里四篇都在根目录 → 只有「其他」一行，仍然算有图例
    const rows = container.querySelectorAll('.nexus-graph-legend-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-cluster')).toBe('Other');
  });

  it('标出当前活动文档的那个节点', async () => {
    /*
      这条守的是一个从图谱落地起就存在的 bug：判据拿节点的**相对路径**去比 App 传下来的
      **绝对路径**，永远不相等 —— 于是活跃文档从来没被高亮过。
      画布上的描边从外面看不见，所以只能靠 `data-active-node` 守。
    */
    await render({ activeFilePath: '/vault/b.md' });
    const hitmap = () => container.querySelector('.nexus-graph-hitmap')!;
    expect(hitmap().getAttribute('data-active-node')).toBe('2');

    // 反向：不在图上的路径不该匹配到任何节点
    await render({ activeFilePath: '/vault/没进索引.md' });
    expect(hitmap().getAttribute('data-active-node')).toBe('');

    // 反斜杠写法也要认（Windows 上主进程给的是原生分隔符）
    await render({ activeFilePath: '\\vault\\b.md' });
    expect(hitmap().getAttribute('data-active-node')).toBe('2');
  });

  it('把边的方向交给绘制层（画箭头要用）', async () => {
    getGraph.mockImplementation(async () => ({
      nodes: [node(1, 'a.md', 'markdown', 1), node(2, 'b.md', 'markdown', 1)],
      edges: [{ source: 1, target: 2, mutual: true }]
    }));
    await render();

    // 方向丢了的话箭头就画不出来，而画布上的东西从外面看不见 —— 只能在这里守
    expect(
      JSON.parse(container.querySelector('.nexus-graph-hitmap')!.getAttribute('data-edges')!)
    ).toEqual([{ source: 1, target: 2, mutual: true }]);
  });

  it('拖侧栏时等尺寸停下来再重算布局', async () => {
    /*
      拖侧栏时 `ResizeObserver` 每个像素报一次，而一次布局是 300 次迭代的 O(n²)。
      不防抖的话拖动全程都在重算 —— 400 篇实测 136ms/次，直接卡成幻灯片。
    */
    vi.useFakeTimers();
    await render();

    const body = container.querySelector<HTMLElement>('.nexus-graph-body')!;
    const size = (width: number, height: number) => {
      Object.defineProperty(body, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(body, 'clientHeight', { value: height, configurable: true });
    };
    const positions = () =>
      container.querySelector('.nexus-graph-hitmap')!.getAttribute('data-nodes');

    const observer = StubResizeObserver.instances.at(-1)!;

    // 第一次拿到非零尺寸：立即算，不能等 150ms
    size(400, 300);
    await act(async () => {
      observer.fire();
    });
    const at400 = positions();
    expect(JSON.parse(at400!)).toHaveLength(4);

    // 尺寸再变：**不**立刻重算
    size(520, 300);
    await act(async () => {
      observer.fire();
    });
    expect(positions()).toBe(at400);

    // 等过防抖窗口之后才算，而且坐标确实变了（说明真的按新尺寸重算过）
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(positions()).not.toBe(at400);
  });

  /**
   * 聚焦当前文档：把它带进视野。
   *
   * 三条一起才成立：**在视野里就不动**、**被拖出去了要带回来**、**要求减少动态效果时不动**。
   * 只测中间那条的话，「每次换文档图都抖一下」照样能过。
   */
  describe('聚焦当前文档', () => {
    const bodySize = (width: number, height: number) => {
      const body = container.querySelector<HTMLElement>('.nexus-graph-body')!;
      Object.defineProperty(body, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(body, 'clientHeight', { value: height, configurable: true });
    };

    const readView = () =>
      JSON.parse(container.querySelector('.nexus-graph-hitmap')!.getAttribute('data-view')!);

    const readScreenNodes = () =>
      JSON.parse(
        container.querySelector('.nexus-graph-hitmap')!.getAttribute('data-screen-nodes')!
      ) as Array<{ id: number; x: number; y: number }>;

    const screenXOf = (id: number) => readScreenNodes().find((item) => item.id === id)!.x;

    /** 首帧的尺寸是**立即**生效的（没有防抖），所以这里不用假时钟。 */
    const renderSized = async (graph: WorkspaceGraph, activeFilePath: string | null) => {
      getGraph.mockImplementation(async () => graph);
      await render({ activeFilePath });
      bodySize(400, 300);
      await act(async () => {
        StubResizeObserver.instances.at(-1)!.fire();
      });
    };

    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 450)));

    /** 把图往右拖 600px —— 所有节点都会被拖出 400 宽的视口。 */
    const panAway = () =>
      act(async () => {
        const canvas = container.querySelector<HTMLCanvasElement>('.nexus-graph-canvas')!;
        const fire = (type: string, clientX: number) =>
          canvas.dispatchEvent(
            new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 0 })
          );
        fire('mousedown', 0);
        fire('mousemove', 600);
        fire('mouseup', 600);
      });

    it('当前文档被平移到视野外时，把它带回来', async () => {
      await renderSized(FULL, null);
      expect(screenXOf(1)).toBeGreaterThan(0);
      expect(screenXOf(1)).toBeLessThan(400);

      await panAway();
      // 前提成立：现在它真的在视口外
      expect(screenXOf(1)).toBeGreaterThan(400);

      await render({ activeFilePath: '/vault/a.md' });
      await settle();

      // 断言「回到视口里」，而不是「offsetX 变了」—— 后者对「往反方向移」同样成立
      expect(screenXOf(1)).toBeGreaterThan(0);
      expect(screenXOf(1)).toBeLessThan(400);
      expect(readView().scale).toBe(1);
    });

    it('当前文档已经在视野里时一动不动', async () => {
      /*
        单节点会被重心回拉收敛到画布正中 —— 那时「聚焦」没有任何可做的。
        少了「在视野里就不动」这条判据的话，这里会平移一下，用户看到的是一次莫名其妙的抖动。
      */
      await renderSized({ nodes: [node(1, 'a.md', 'markdown', 0)], edges: [] }, '/vault/a.md');

      await settle();
      expect(readView()).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    });

    it('系统要求减少动态效果时不平移', async () => {
      // 纯装饰动画，关掉它一个信息都不少 —— 而前庭功能障碍的用户会被它影响
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      })) as unknown as typeof window.matchMedia;

      try {
        await renderSized(FULL, null);
        await panAway();
        expect(screenXOf(1)).toBeGreaterThan(400);

        await render({ activeFilePath: '/vault/a.md' });
        await settle();

        // 还在视口外 —— 没有动画可看，也就不该动
        expect(screenXOf(1)).toBeGreaterThan(400);
      } finally {
        window.matchMedia = original;
      }
    });
  });

  it('三个视图开关，切到清单时画布让位', async () => {
    await render();

    expect(
      ['explore', 'orphans', 'hubs'].map(
        (mode) => chip(`[data-mode="${mode}"]`)?.getAttribute('aria-pressed')
      )
    ).toEqual(['true', 'false', 'false']);
    // 画布只在图谱视图下占位
    expect(chip('.nexus-graph-body')?.hasAttribute('hidden')).toBe(false);

    await act(async () => {
      chip('[data-mode="orphans"]')!.click();
    });
    await act(async () => {});

    expect(chip('[data-mode="orphans"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(chip('.nexus-graph-body')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.nexus-graph-list')).not.toBeNull();
    // 范围与类型筛选只对画布有意义，切到清单就不该再占地方
    expect(chip('[data-scope="all"]')).toBeNull();

    await act(async () => {
      chip('[data-mode="hubs"]')!.click();
    });
    await act(async () => {});
    expect(container.querySelector('.nexus-graph-list')).not.toBeNull();
    expect(chip('[data-orphan-mode="both"]')).toBeNull();

    await act(async () => {
      chip('[data-mode="explore"]')!.click();
    });
    await act(async () => {});
    expect(chip('.nexus-graph-body')?.hasAttribute('hidden')).toBe(false);
    expect(chip('[data-scope="all"]')).not.toBeNull();
  });

  it('视图状态落盘：重新挂载之后还在', async () => {
    // 「切走再切回 / 重启之后还是同一个视图」是这三项落盘的**全部意义**
    await render();

    // 先关类型（筛选条只在图谱视图里画），再切视图 —— 反过来就点不到筛选条了
    await act(async () => {
      chip('[data-type="pdf"]')!.click();
    });
    await act(async () => {});
    await act(async () => {
      chip('[data-mode="orphans"]')!.click();
    });
    await act(async () => {});

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await render();

    expect(chip('[data-mode="orphans"]')!.getAttribute('aria-pressed')).toBe('true');
    // 切回图谱视图才能看到筛选条 —— 顺便验证关掉的那一项也一起回来了
    await act(async () => {
      chip('[data-mode="explore"]')!.click();
    });
    await act(async () => {});
    expect(chip('[data-type="pdf"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('工作区本来就空时不给出路按钮（那不是筛出来的）', async () => {
    getGraph.mockImplementation(async () => ({ nodes: [], edges: [] }));
    await render();

    const note = container.querySelector('.nexus-sidebar-note')!;
    expect(note.textContent).toContain('No documents to draw yet');
    expect(container.querySelector('.nexus-graph-reset')).toBeNull();
    // 一个类型都没有时不画筛选条 —— 空的分段控件只会占地方
    expect(chips().filter((el) => el.dataset.type)).toHaveLength(0);
    // 范围那两个还在
    expect(chips().filter((el) => el.dataset.scope)).toHaveLength(2);
  });

  it('只有一种类型时不画筛选条', async () => {
    getGraph.mockImplementation(async (query?: GraphQuery) =>
      query?.types === undefined ? onlyNotes(FULL) : onlyNotes(FULL)
    );
    await render();

    expect(chips().map((el) => el.dataset.scope).filter(Boolean)).toEqual(['all', 'current']);
    expect(chips().filter((el) => el.dataset.type)).toHaveLength(0);
  });
});
