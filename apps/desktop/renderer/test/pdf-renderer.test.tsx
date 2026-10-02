// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfRenderer from '../src/viewer/pdf/PdfRenderer.js';
import { settings } from '../src/platform.js';
import type { ViewerDocumentDescriptor } from '../src/viewer/types.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `pdfjs-dist` 的替身。
 *
 * 这个文件测的是**渲染器自己的状态机与 DOM**：加载中 / 成功 / 失败、翻页边界、
 * 换文档。真实解析、真 worker、真像素归 `p3-07-pdf-viewer.test.ts`（真 Electron）。
 * 在这里让 pdfjs 真跑没有意义 —— happy-dom 没有 canvas 实现，就算解析成功也
 * 画不出东西，断言只会测到我自己塞进去的数字。
 *
 * `vi.hoisted` 是必需的：`vi.mock` 的工厂会被提升到 import 之前，
 * 直接引用外层的 `vi.fn()` 会在初始化前被求值。
 */
const { getDocumentMock, textLayerCtor } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  /** 文本层的构造参数 —— 断言 `--scale-factor` 与 viewport 必须配套时要用到。 */
  textLayerCtor: vi.fn()
}));

vi.mock('pdfjs-dist', () => ({
  // 组件在模块顶层写 `workerSrc`，所以这里必须是个可写对象而不是常量
  GlobalWorkerOptions: { workerSrc: '' },
  OutputScale: class {
    public sx = 1;
    public sy = 1;
    public get scaled(): boolean {
      return this.sx !== 1 || this.sy !== 1;
    }
  },
  RenderingCancelledException: class RenderingCancelledException extends Error {},
  TextLayer: class {
    public constructor(options: unknown) {
      textLayerCtor(options);
    }

    public render(): Promise<void> {
      return Promise.resolve();
    }

    public cancel(): void {}
  },
  getDocument: (...args: unknown[]) => getDocumentMock(...args)
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/mock/pdf.worker.min.mjs'
}));

/**
 * `IntersectionObserver` 的替身。
 *
 * happy-dom 没有它，而连续模式的懒渲染全靠它。**默认不触发** —— 自动触发的话
 * 「没进入视野的页不渲染」这条判据会变成恒真，而它正是懒渲染唯一值得测的东西。
 */
const { intersections } = vi.hoisted(() => ({
  intersections: [] as Array<{ callback: (entries: unknown[]) => void; targets: Element[] }>
}));

class MockIntersectionObserver {
  private readonly entry: { callback: (entries: unknown[]) => void; targets: Element[] };

  public constructor(callback: (entries: unknown[]) => void) {
    this.entry = { callback, targets: [] };
    intersections.push(this.entry);
  }

  public observe(target: Element): void {
    this.entry.targets.push(target);
  }

  public unobserve(): void {}

  public disconnect(): void {
    const index = intersections.indexOf(this.entry);
    if (index >= 0) intersections.splice(index, 1);
  }
}

vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

/** 让所有观察者报告「目标进入视野了」。 */
function triggerIntersections(): void {
  for (const entry of [...intersections]) {
    entry.callback(entry.targets.map((target) => ({ isIntersecting: true, target })));
  }
}

const DOC: ViewerDocumentDescriptor = {
  path: 'D:\\vault\\assets\\spec.pdf',
  name: 'spec.pdf',
  type: 'pdf',
  page: null,
  citationBase: 'D:////vault'
};

/** 一次 `getDocument` 的返回值：`promise` 由测试自己决定何时兑现。 */
interface PendingLoad {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly destroy: ReturnType<typeof vi.fn>;
}

function createPendingLoad(): PendingLoad {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, destroy: vi.fn() };
}

/** 假大纲节点。`dest` 里放 `{ num: n }`，由下面的 `getPageIndex` 换回第 n+1 页。 */
interface FakeOutlineNode {
  readonly title: string;
  readonly dest?: unknown;
  readonly items?: readonly FakeOutlineNode[];
}

/** 一份足以驱动 UI 的假文档。`render` 立刻完成 —— 画不出东西在这里不重要。 */
function createFakeDocument(
  pageCount: number,
  outline: readonly FakeOutlineNode[] | null = null
): unknown {
  return {
    numPages: pageCount,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 200 * scale,
        scale
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined })
    }),
    getOutline: async () => outline,
    getDestination: async (name: string) => [{ num: 0 }, name],
    // 页码解析的唯一入口：`dest[0]` 里的 `num` 就是页序号（0 起）
    getPageIndex: async (ref: { num: number }) => ref.num,
    destroy: async () => undefined
  };
}

describe('PdfRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getDocumentMock.mockReset();
    textLayerCtor.mockReset();
    intersections.length = 0;
    // 翻页方式存在 localStorage 里，跨用例会残留 —— 不还原的话「默认单页」那几条
    // 会因为上一个用例切成了连续而红，而红的位置看起来毫无关联。
    settings.set('viewer.pdfPageLayout', 'single');
    // happy-dom 没有 canvas 实现，默认 `getContext` 返回 null —— 那会让渲染器
    // 「跳过绘制」而不是抛错（抛错会被它当成加载失败，这个文件就永远在测错误态）。
    // 但跳过绘制也意味着**文本层不会构造**，所以给一个空 context，让这条路径走完：
    // `page.render` 是替身、立即 resolve，不需要真 context。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    settings.set('viewer.pdfPageLayout', 'single');
    // 桥是挂在 window 上的，不清理会漏到下一个用例（`restoreAllMocks` 不管它）
    delete (window as unknown as Record<string, unknown>).nexus;
  });

  const renderPdf = (doc: ViewerDocumentDescriptor = DOC): void => {
    act(() => {
      root.render(<PdfRenderer document={doc} />);
    });
  };

  const pageButtons = (): HTMLButtonElement[] =>
    [...container.querySelectorAll<HTMLButtonElement>('.nexus-pdf-page-button')];

  /** 打开侧栏并切到大纲标签页。 */
  const openOutlineTab = async (): Promise<void> => {
    await act(async () => {
      container
        .querySelector<HTMLElement>('.nexus-pdf-sidebar-button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('.nexus-pdf-sidebar-tab[data-tab="outline"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  /**
   * 往受控输入框里打字。
   *
   * React 的 `onChange` 挂在原生 `input` 上，而且它给节点装了一层 value 拦截器 ——
   * 直接 `input.value = x` 会被拦截器记成「已经是最新值」，随后派发的 `input` 事件
   * 会被判成「没变」而**不触发 onChange**，草稿一直停在初值。所以走原生 setter。
   */
  const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const pressKey = async (input: HTMLInputElement, key: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    return event;
  };

  /** 起一份 `pageCount` 页的假文档并等它加载完 —— 后面这些用例都从这一步开始。 */
  const mountWithPages = async (pageCount: number): Promise<void> => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(pageCount));
    });
  };

  /**
   * 失焦提交。
   *
   * React 的 `onBlur` 挂的是原生 **`focusout`**（React 17 起），而 happy-dom 的
   * `blur()` 只对**当前聚焦**的元素派发 —— 对没聚焦的框调 `blur()` 是空操作。
   */
  const blurFrom = async (input: HTMLInputElement): Promise<void> => {
    await act(async () => {
      input.focus();
      input.blur();
    });
  };

  const pageInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('.nexus-pdf-page-input')!;

  const zoomInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('.nexus-pdf-zoom-level')!;

  /** 单页模式下当前挂在正文区的那一页 —— 页码跳转的直接证据。 */
  const renderedPage = (): string | null =>
    container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number') ?? null;

  /**
   * 给滚动几何装上能读写的替身。
   *
   * happy-dom 不做布局：`offsetTop` / `offsetHeight` 恒为 0，`scrollTop` 也只是个不记账的
   * 存取器。而「按实测的页几何重算滚动位置」这条链全靠这三个量 —— 不装替身的话，
   * 量不到任何一页、锚点直接退回「对齐到当前页」，用例会绿得毫无意义。
   */
  const stubPdfGeometry = (pageTop: number, pageHeight: number) => {
    const stage = container.querySelector<HTMLElement>('.nexus-pdf-stage')!;
    const page = container.querySelector<HTMLElement>('.nexus-pdf-page')!;
    const box = { top: pageTop, height: pageHeight };
    let scrollTop = 0;

    Object.defineProperty(page, 'offsetTop', { configurable: true, get: () => box.top });
    Object.defineProperty(page, 'offsetHeight', { configurable: true, get: () => box.height });
    Object.defineProperty(stage, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    });

    return {
      /** 缩放后页高会变 —— 真实浏览器里这是重渲染的直接结果。 */
      resize: (top: number, height: number): void => {
        box.top = top;
        box.height = height;
      },
      scrollTop: (): number => scrollTop,
      setScrollTop: (value: number): void => {
        scrollTop = value;
      }
    };
  };

  /**
   * 造一个滚轮事件。
   *
   * **happy-dom 的 `WheelEvent` 只认 `deltaY`** —— `ctrlKey` / `clientX` / `clientY` 从 init
   * 里读出来是 `undefined`（实测），而这三个正是「要不要缩放」与「锚在哪一点」的判据。
   * 不补的话处理器会在第一行 `!event.ctrlKey` 就返回，用例绿得毫无意义。
   */
  const makeWheel = (init: {
    deltaY: number;
    ctrlKey?: boolean;
    clientY?: number;
  }): WheelEvent => {
    const event = new WheelEvent('wheel', {
      deltaY: init.deltaY,
      bubbles: true,
      cancelable: true
    });
    Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false });
    Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0 });
    return event;
  };

  /** 滚轮缩放的对齐落在 `requestAnimationFrame` 上，所以要等一个真实的帧过去。 */
  const wheelOn = async (
    selector: string,
    init: Parameters<typeof makeWheel>[0],
    afterDispatch?: () => void
  ): Promise<WheelEvent> => {
    const event = makeWheel(init);
    await act(async () => {
      container.querySelector<HTMLElement>(selector)!.dispatchEvent(event);
      // 缩放引起的重渲染发生在处理器返回之后 —— 用它模拟「页高已经变了」
      afterDispatch?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    return event;
  };

  it('请求的是 nexus-asset:// 而不是 file://，并带上 cmap 与标准字体目录', () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const options = getDocumentMock.mock.calls[0][0] as Record<string, string | boolean>;
    // PDF 必须走带 Range 的通道（§10.4 定案 A：file:// 留给图片）
    expect(options.url).toBe(toAssetUrlExpectation(DOC.path));
    expect(String(options.url).startsWith('nexus-asset://')).toBe(true);
    // 这两个参数必须**是绝对 URL**：它们会被传给 worker，而 worker 里的相对路径
    // 是相对 worker 脚本解析的 —— 传相对路径会静默取不到 cmap，中文 PDF 变空白。
    expect(String(options.cMapUrl)).toMatch(/^[a-z]+:\/\//);
    expect(String(options.standardFontDataUrl)).toMatch(/^[a-z]+:\/\//);
    expect(options.cMapPacked).toBe(true);
  });

  it('加载中显示进度态，且正文区已在位（避免 spinner 消失时布局跳动）', () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    expect(container.querySelector('.nexus-state-container')).not.toBeNull();
    // 正文区容器先立着，加载完成后页面直接落进去 —— 不会「浮层消失 → 内容撑开」跳一下
    expect(container.querySelector('.nexus-pdf-pages')).not.toBeNull();
    expect(container.querySelector('.nexus-pdf-name')?.textContent).toBe('spec.pdf');
    // 还没加载完，不该有错误卡
    expect(container.querySelector('.nexus-error-card')).toBeNull();
  });

  it('加载失败出错误卡并给出路径 —— 那是用户唯一能据以行动的信息', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.reject(new Error('boom'));
    });

    expect(container.querySelector('.nexus-pdf-viewer')).toBeNull();
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
    expect(container.querySelector('.nexus-pdf-error-path')?.textContent).toBe(DOC.path);
  });

  it('单页文档：两个翻页按钮都不可用 —— 边界要如实反映在可交互性上', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(1));
    });

    const buttons = pageButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(true);

    // 页码框只收数字，`/ 总页数` 是框外的另一段 —— 断言 value 而不是整块 textContent
    const pageInput = container.querySelector<HTMLInputElement>('.nexus-pdf-page-input');
    expect(pageInput?.value).toBe('1');
    expect(pageInput?.disabled).toBe(false);
    expect(container.querySelector('.nexus-pdf-page-total')?.textContent).toContain('1');
  });

  it('多页文档：从第 1 页翻到第 2 页再翻回来，按钮边界跟着变', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    const pageNumber = (): string | null =>
      container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number') ?? null;

    expect(pageNumber()).toBe('1');
    // 第 1 页：「上一页」必须不可用
    expect(pageButtons()[0].disabled).toBe(true);
    expect(pageButtons()[1].disabled).toBe(false);

    await act(async () => {
      pageButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pageNumber()).toBe('2');
    expect(pageButtons()[0].disabled).toBe(false);
    expect(pageButtons()[1].disabled).toBe(false);

    await act(async () => {
      pageButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pageNumber()).toBe('1');
    expect(pageButtons()[0].disabled).toBe(true);

    // 末页：「下一页」必须不可用
    await act(async () => {
      pageButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      pageButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pageNumber()).toBe('3');
    expect(pageButtons()[1].disabled).toBe(true);
  });

  it('卸载时取消在途加载 —— 否则切走文档后 pdfjs 还在下载整份字节', () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    // 用「换成别的内容」触发卸载，而不是直接 `root.unmount()` ——
    // 后者会让 afterEach 里的收尾 unmount 变成第二次调用。
    act(() => {
      root.render(<div />);
    });

    expect(load.destroy).toHaveBeenCalled();
  });

  it('换一份文档就是换一个实例 —— 上一份的页码不会挂到下一份上', async () => {
    // 与 ImageRenderer 同一条契约（见 ViewerSurface 的 `key={doc.path}`）：
    // 组件自己没有「按路径重置」的逻辑，靠宿主换 key 换实例。
    const first = createPendingLoad();
    getDocumentMock.mockReturnValue(first);
    renderPdf();

    await act(async () => {
      first.resolve(createFakeDocument(3));
    });
    await act(async () => {
      pageButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('2');

    const second = createPendingLoad();
    getDocumentMock.mockReturnValue(second);
    const next: ViewerDocumentDescriptor = {
      path: 'D:\\vault\\assets\\other.pdf',
      name: 'other.pdf',
      type: 'pdf',
      page: null,
      citationBase: 'D:////vault'
    };
    act(() => {
      root.render(<PdfRenderer key={next.path} document={next} />);
    });

    await act(async () => {
      second.resolve(createFakeDocument(3));
    });

    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('1');
    expect(container.querySelector('.nexus-pdf-name')?.textContent).toBe('other.pdf');
  });

  it('引用里的 #page= 锚点决定初始页 —— 换页不换 key，靠 doc.page 接住', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf({ ...DOC, page: 3 });

    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('3');
  });

  it('锚点页码超出页数时钳到末页 —— 不钳住会让渲染 reject，界面变成「加载失败」', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf({ ...DOC, page: 99 });

    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('2');
  });

  it('文本层的 --scale-factor 与 viewport 的 scale 是同一个数', async () => {
    // 两者不一致时选中的字与画面上的字对不上 —— 能选，但选偏，且不报错
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    const layer = container.querySelector<HTMLElement>('.nexus-pdf-text-layer');
    const options = textLayerCtor.mock.calls[0]?.[0] as { viewport: { scale: number } };
    expect(options.viewport.scale).toBe(1.5);
    expect(layer?.style.getPropertyValue('--scale-factor')).toBe(String(options.viewport.scale));
  });

  it('选中文本层里的文字 → 生成引用 → 复制走 copyText 桥', async () => {
    const copyText = vi.fn().mockResolvedValue(true);
    (window as unknown as { nexus: unknown }).nexus = { copyText };

    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    // mock 的 TextLayer 不产生 span，手动塞一个 —— 组件判的是「选区在不在这一层里」
    const layer = container.querySelector<HTMLElement>('.nexus-pdf-text-layer');
    const span = document.createElement('span');
    span.textContent = 'DMA   controller\nsupports';
    layer?.appendChild(span);

    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // 引文折成一行（text layer 的换行是排版产物），路径相对 citationBase
    const expected = '> DMA controller supports\n\n[spec](assets/spec.pdf#page=1)';
    expect(container.querySelector('.nexus-pdf-citation-text')?.textContent).toBe(expected);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.nexus-pdf-copy-button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(copyText).toHaveBeenCalledWith(expected);
    // 判据用组件自己的状态属性，不用文案 —— 加载态与空态常共用同一个类名
    expect(container.querySelector('.nexus-pdf-citation')?.getAttribute('data-copy-state')).toBe(
      'copied'
    );
  });

  it('选区不在文本层里时不给引用 —— 半截界面文字拼出来的引用看起来完全正常', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    const outside = document.createElement('div');
    outside.textContent = '工具栏上的字';
    container.appendChild(outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(container.querySelector('.nexus-pdf-citation')).toBeNull();
  });

  // ── 阅读增强：连续滚动 / 缩放 / 缩略图 / 大纲 ──────────────────────────

  it('连续模式：每页都有容器，但只有进入视野的才真的渲染', async () => {
    settings.set('viewer.pdfPageLayout', 'continuous');
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    // 三页的容器都在位 —— 高度靠第一页的尺寸估出来，滚动条长度才是对的
    expect(container.querySelectorAll('.nexus-pdf-page')).toHaveLength(3);
    // 一页都还没渲染：观察者一次都没报告过目标进入视野
    expect(container.querySelectorAll('.nexus-pdf-page[data-rendered="true"]')).toHaveLength(0);

    await act(async () => {
      triggerIntersections();
    });

    expect(
      container.querySelectorAll('.nexus-pdf-page[data-rendered="true"]').length
    ).toBeGreaterThan(0);
  });

  it('单页模式只挂一页 —— 连续模式那一套不能漏到单页里', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(5));
    });

    expect(container.querySelectorAll('.nexus-pdf-page')).toHaveLength(1);
    expect(container.querySelector('.nexus-pdf-viewer')?.getAttribute('data-layout')).toBe('single');
  });

  it('工具栏切换翻页方式写回设置 —— 两个入口必须是同一个值', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    expect(settings.get('viewer.pdfPageLayout')).toBe('single');

    await act(async () => {
      container
        .querySelector<HTMLElement>('.nexus-pdf-layout-button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 只改本地 state 的话设置页看不到变化，用户会以为「设置没生效」
    expect(settings.get('viewer.pdfPageLayout')).toBe('continuous');
    expect(container.querySelector('.nexus-pdf-viewer')?.getAttribute('data-layout')).toBe(
      'continuous'
    );
  });

  it('缩放：走一档之后百分比与画布宽度一起变', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    const zoomLevel = (): string | null =>
      container.querySelector<HTMLInputElement>('.nexus-pdf-zoom-level')?.value ?? null;
    const canvasWidth = (): string =>
      container.querySelector<HTMLElement>('.nexus-pdf-canvas')?.style.width ?? '';

    expect(zoomLevel()).toBe('100');
    const before = canvasWidth();

    const zoomButtons = [...container.querySelectorAll<HTMLButtonElement>('.nexus-pdf-zoom-button')];
    // 顺序是「缩小」「放大」
    await act(async () => {
      zoomButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(zoomLevel()).toBe('125');
    // 只改百分比不重画 canvas 就是「数字变了画面没变」—— 两者必须一起动
    expect(canvasWidth()).not.toBe(before);
  });

  it('缩放夹在区间内：连点到顶之后按钮不可用', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    const zoomButtons = (): HTMLButtonElement[] => [
      ...container.querySelectorAll<HTMLButtonElement>('.nexus-pdf-zoom-button')
    ];

    for (let step = 0; step < 20; step += 1) {
      await act(async () => {
        zoomButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    expect(container.querySelector<HTMLInputElement>('.nexus-pdf-zoom-level')?.value).toBe('300');
    expect(zoomButtons()[1].disabled).toBe(true);
  });

  it('页码框：回车跳到目标页', async () => {
    await mountWithPages(5);

    await typeInto(pageInput(), '4');
    await pressKey(pageInput(), 'Enter');

    expect(renderedPage()).toBe('4');
    expect(pageInput().value).toBe('4');
  });

  it('页码框：越界钳到末页；已经在末页时草稿也要归一', async () => {
    await mountWithPages(5);

    await typeInto(pageInput(), '5');
    await pressKey(pageInput(), 'Enter');
    expect(renderedPage()).toBe('5');

    // 已经在末页：钳完还是第 5 页，`pageNumber` 没变、同步 effect 不触发 ——
    // 不手动写回草稿的话框里会一直挂着 999，看起来像「跳过去了但没跳」
    await typeInto(pageInput(), '999');
    await pressKey(pageInput(), 'Enter');

    expect(renderedPage()).toBe('5');
    expect(pageInput().value).toBe('5');
  });

  it('页码框：Escape 取消输入，不跳页，且拦住这次按键', async () => {
    await mountWithPages(5);

    await typeInto(pageInput(), '4');
    const event = await pressKey(pageInput(), 'Escape');

    expect(renderedPage()).toBe('1');
    expect(pageInput().value).toBe('1');
    // 不拦的话这个键会冒泡到全局快捷键，用户想取消输入却把别的面板一起关掉了
    expect(event.defaultPrevented).toBe(true);
  });

  it('页码框：清空后失焦回到当前页，而不是当成第 1 页', async () => {
    await mountWithPages(5);

    await typeInto(pageInput(), '3');
    await pressKey(pageInput(), 'Enter');
    expect(renderedPage()).toBe('3');

    await typeInto(pageInput(), '');
    await blurFrom(pageInput());

    // 空串 parse 出 NaN，回退到当前页 —— 手滑清空输入框不该跳页
    expect(renderedPage()).toBe('3');
    expect(pageInput().value).toBe('3');
  });

  it('页码框：只收数字，粘贴进来的别的字符被滤掉', async () => {
    await mountWithPages(5);

    await typeInto(pageInput(), '第4页');

    expect(pageInput().value).toBe('4');
  });

  it('缩放框：回车改百分比，画布宽度一起变', async () => {
    await mountWithPages(2);

    const canvasWidth = (): string =>
      container.querySelector<HTMLElement>('.nexus-pdf-canvas')?.style.width ?? '';
    const before = canvasWidth();

    await typeInto(zoomInput(), '200');
    await pressKey(zoomInput(), 'Enter');

    expect(zoomInput().value).toBe('200');
    // 只改数字不重画就是「数字变了画面没变」—— 两者必须一起动
    expect(canvasWidth()).not.toBe(before);
  });

  it('缩放框：越界钳到上限，框里不残留越界的数字', async () => {
    await mountWithPages(2);

    await typeInto(zoomInput(), '500');
    await pressKey(zoomInput(), 'Enter');

    expect(zoomInput().value).toBe('300');
    // 不只是草稿被改写了 —— 缩放本身也真的到了顶
    const zoomButtons = [...container.querySelectorAll<HTMLButtonElement>('.nexus-pdf-zoom-button')];
    expect(zoomButtons[1].disabled).toBe(true);
  });

  it('缩放框：Escape 取消输入，且拦住这次按键', async () => {
    await mountWithPages(2);

    await typeInto(zoomInput(), '200');
    const event = await pressKey(zoomInput(), 'Escape');

    expect(zoomInput().value).toBe('100');
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl + 滚轮缩放，并把光标下那一点放回原处', async () => {
    await mountWithPages(2);
    // 一页高 800、页顶在内容坐标 16（stage 的内边距），滚到 500、光标压在视口内 100 处
    const geometry = stubPdfGeometry(16, 800);
    geometry.setScrollTop(500);

    // 派发在 canvas 上：监听挂在阅读器根节点上，靠冒泡收到它；
    // 而锚点要求 `event.target` 落在 stage 里（工具栏 / 侧栏上的滚轮没有「光标下那一点」）
    const event = await wheelOn(
      '.nexus-pdf-canvas',
      { deltaY: -100, ctrlKey: true, clientY: 100 },
      // 缩放后页高变了 —— 真实浏览器里这是重渲染的直接结果
      () => geometry.resize(16, 1600)
    );

    expect(zoomInput().value).toBe('111');
    // 缩放前：内容坐标 600 在第 1 页（16–816）的 0.73 处。
    // 缩放后：第 1 页是 16–1616，0.73 处 = 1184，减掉光标在视口里的 100 → 1084。
    // 用「旧位置 × 比例」会算出 1000（500 × 2），差 84px —— 页数越多差得越离谱。
    expect(geometry.scrollTop()).toBe(1084);
    // 不拦的话 Electron 会把它当成整个界面的缩放
    expect(event.defaultPrevented).toBe(true);
  });

  it('不按修饰键的滚轮只滚动 —— 连续模式里滚动是滚轮的主职', async () => {
    await mountWithPages(2);

    const event = await wheelOn('.nexus-pdf-canvas', { deltaY: -100, clientY: 100 });

    expect(zoomInput().value).toBe('100');
    // 拦了就滚不动了
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl + 滚轮到上限后不再缩放，但仍然拦住 —— 否则界面会被放大', async () => {
    await mountWithPages(2);
    await typeInto(zoomInput(), '300');
    await pressKey(zoomInput(), 'Enter');
    expect(zoomInput().value).toBe('300');

    const event = await wheelOn('.nexus-pdf-canvas', { deltaY: -100, ctrlKey: true, clientY: 100 });

    expect(zoomInput().value).toBe('300');
    // 那几次不拦的话，用户看到的是「滚到上限之后界面开始放大」
    expect(event.defaultPrevented).toBe(true);
  });

  it('光标停在工具栏上时同样拦住，但不带锚点 —— 那里没有「光标下那一点」', async () => {
    await mountWithPages(2);
    const geometry = stubPdfGeometry(16, 800);
    geometry.setScrollTop(500);

    const event = await wheelOn('.nexus-pdf-toolbar', {
      deltaY: -100,
      ctrlKey: true,
      clientY: 100
    });

    expect(zoomInput().value).toBe('111');
    expect(event.defaultPrevented).toBe(true);
    // 单页模式下退回「对齐到当前页」而它无事可做，滚动位置原样不动 —— 没有被误当成锚点
    expect(geometry.scrollTop()).toBe(500);
  });

  it('侧栏默认收起，打开后是缩略图，点第 3 张跳到第 3 页', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    // 默认收起：侧栏是这次阅读的临时状态，不该一打开就吃掉正文宽度
    expect(container.querySelector('.nexus-pdf-sidebar')).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLElement>('.nexus-pdf-sidebar-button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const thumbs = [...container.querySelectorAll<HTMLElement>('.nexus-pdf-thumb-button')];
    expect(thumbs).toHaveLength(3);

    await act(async () => {
      thumbs[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('3');
  });

  it('侧栏按钮：可见文字就是可访问名，开合状态写在 aria-pressed 上', async () => {
    await mountWithPages(2);

    const sidebarButton = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('.nexus-pdf-sidebar-button')!;

    const visible = sidebarButton().textContent?.trim() ?? '';
    expect(visible.length).toBeGreaterThan(0);

    // 有 `aria-label` 时它**覆盖**可见文字成为可访问名 —— 于是视觉用户看到「导航」、
    // 屏幕阅读器读「显示/隐藏导航」，同一次点击对两类用户说的是两件事，
    // 而语音控制按可见文字点不到（WCAG 2.5.3 Label in Name）。
    // 判据是「可访问名**包含**可见文字」，不要求二者相等：`aria-label` 允许更长，
    // 但不允许换一个不相干的名字。
    const accessible = sidebarButton().getAttribute('aria-label') ?? visible;
    expect(accessible).toContain(visible);

    // 开合状态与按钮的可见激活态（`[aria-pressed='true']` 的底色）必须来自同一个表达式
    expect(sidebarButton().getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      sidebarButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sidebarButton().getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.nexus-pdf-sidebar')).not.toBeNull();
  });

  it('大纲：列出书签、按层级缩进，点击跳到对应页', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(
        createFakeDocument(4, [
          { title: '第一章', dest: [{ num: 0 }], items: [{ title: '1.1', dest: [{ num: 1 }] }] },
          { title: '第二章', dest: [{ num: 2 }] }
        ])
      );
    });

    await openOutlineTab();

    const items = [...container.querySelectorAll<HTMLElement>('.nexus-pdf-outline-item')];
    expect(items.map((item) => item.textContent)).toEqual(['第一章', '1.1', '第二章']);
    // 层级是数据，用 `data-depth` 断言而不是量样式 —— happy-dom 不做布局
    expect(items.map((item) => item.dataset.depth)).toEqual(['0', '1', '0']);

    await act(async () => {
      items[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.nexus-pdf-page')?.getAttribute('data-page-number')).toBe('3');
  });

  it('没有大纲时给空态，而不是一栏空白', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();
    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    await openOutlineTab();

    expect(container.querySelector('.nexus-pdf-sidebar-empty')).not.toBeNull();
    expect(container.querySelectorAll('.nexus-pdf-outline-item')).toHaveLength(0);
  });
});

/**
 * 期望的 URL 形状**在本文件里独立写出来**，不从 `asset-url.ts` 借用。
 *
 * 借用的话，`toAssetUrl` 改坏了（比如 scheme 拼错）两边会一起错、断言照过。
 * 这里与 `asset-protocol.test.ts` 的往返用例分工不同：那条保证「渲染器与主进程
 * 配套」，这条保证「渲染器产出的确实是这个形状」。
 */
function toAssetUrlExpectation(absolutePath: string): string {
  return `nexus-asset://ws/?path=${encodeURIComponent(absolutePath.replace(/\\/g, '/'))}`;
}
