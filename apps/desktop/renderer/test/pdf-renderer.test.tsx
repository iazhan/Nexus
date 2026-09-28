// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfRenderer from '../src/viewer/pdf/PdfRenderer.js';
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

/** 一份足以驱动 UI 的假文档。`render` 立刻完成 —— 画不出东西在这里不重要。 */
function createFakeDocument(pageCount: number): unknown {
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

  it('加载中显示进度态，且 canvas 已在位（避免 spinner 消失时布局跳动）', () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    expect(container.querySelector('.nexus-state-container')).not.toBeNull();
    expect(container.querySelector('.nexus-pdf-canvas')).not.toBeNull();
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

    const indicator = container.querySelector('.nexus-pdf-page-indicator')?.textContent ?? '';
    expect(indicator).toContain('1');
  });

  it('多页文档：从第 1 页翻到第 2 页再翻回来，按钮边界跟着变', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf();

    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    const pageNumber = (): string | null =>
      container.querySelector('.nexus-pdf-canvas')?.getAttribute('data-page-number') ?? null;

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
    expect(container.querySelector('.nexus-pdf-canvas')?.getAttribute('data-page-number')).toBe('2');

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

    expect(container.querySelector('.nexus-pdf-canvas')?.getAttribute('data-page-number')).toBe('1');
    expect(container.querySelector('.nexus-pdf-name')?.textContent).toBe('other.pdf');
  });

  it('引用里的 #page= 锚点决定初始页 —— 换页不换 key，靠 doc.page 接住', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf({ ...DOC, page: 3 });

    await act(async () => {
      load.resolve(createFakeDocument(3));
    });

    expect(container.querySelector('.nexus-pdf-canvas')?.getAttribute('data-page-number')).toBe('3');
  });

  it('锚点页码超出页数时钳到末页 —— 不钳住会让渲染 reject，界面变成「加载失败」', async () => {
    const load = createPendingLoad();
    getDocumentMock.mockReturnValue(load);
    renderPdf({ ...DOC, page: 99 });

    await act(async () => {
      load.resolve(createFakeDocument(2));
    });

    expect(container.querySelector('.nexus-pdf-canvas')?.getAttribute('data-page-number')).toBe('2');
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
