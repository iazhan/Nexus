// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocxRenderer from '../src/viewer/docx/DocxRenderer.js';
import type { ViewerDocumentDescriptor } from '../src/viewer/types.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `mammoth` 的替身。
 *
 * 这个文件测的是**渲染器自己的状态机与 DOM 装配**：加载中 / 成功 / 空文档 / 失败、
 * shadow root 有没有被正确填充、链接有没有被拦、warning 计数有没有上界面。
 *
 * 真实的 DOCX 解析、真实的 shadow DOM、真实的 `data:` 图片归
 * `p3-08-docx-viewer.test.ts`（真 Electron + 一份手工生成的 ZIP）。
 * 在这里让 mammoth 真跑没有意义：那要先把一份 ZIP 喂进去，而断言的仍然是
 * 「我塞进去的那段 HTML 有没有出现在 DOM 里」—— 中间那步只会增加失败面。
 *
 * `vi.hoisted` 是必需的：`vi.mock` 的工厂会被提升到 import 之前，
 * 直接引用外层的 `vi.fn()` 会在初始化前被求值。
 */
const { convertToHtmlMock } = vi.hoisted(() => ({ convertToHtmlMock: vi.fn() }));

vi.mock('mammoth', () => ({
  default: {
    convertToHtml: (...args: unknown[]) => convertToHtmlMock(...args),
    // 渲染器显式传了 `convertImage`，替身必须提供这个对象 ——
    // 少了它，`convertToHtml` 的第二个参数会变成 `{convertImage: undefined}`，
    // 于是「有没有显式指定图片转换器」这件事就测不出来了。
    images: { dataUri: { __mammothBrand: 'ImageConverter' } }
  }
}));

const DOC: ViewerDocumentDescriptor = {
  path: 'D:\\vault\\assets\\spec.docx',
  name: 'spec.docx',
  type: 'docx'
};

/** 一次 `convertToHtml` 的返回值：由测试决定何时兑现、兑现成什么。 */
interface PendingConversion {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: { value: string; messages: unknown[] }) => void;
  readonly reject: (reason: unknown) => void;
}

function createPendingConversion(): PendingConversion {
  let resolve!: (value: { value: string; messages: unknown[] }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ value: string; messages: unknown[] }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让 `fetch` 成功返回一份「字节」。内容不重要 —— mammoth 是替身。 */
function stubFetchOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8)
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('DocxRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    convertToHtmlMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderDocx = (doc: ViewerDocumentDescriptor = DOC): void => {
    act(() => {
      root.render(<DocxRenderer document={doc} />);
    });
  };

  /** 渲染 + 把异步链路推到底（fetch → arrayBuffer → convertToHtml → setState → effect）。 */
  const renderAndSettle = async (doc: ViewerDocumentDescriptor = DOC): Promise<void> => {
    renderDocx(doc);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const shadow = (): ShadowRoot | null =>
    container.querySelector('.nexus-docx-content')?.shadowRoot ?? null;

  const noticeWarnings = (): string | null =>
    container.querySelector('.nexus-docx-notice')?.getAttribute('data-docx-warnings') ?? null;

  it('向 nexus-asset:// 取字节，并把 ArrayBuffer 交给 mammoth（不是路径、不是 file://）', async () => {
    const fetchMock = stubFetchOk();
    convertToHtmlMock.mockResolvedValue({ value: '<p>hi</p>', messages: [] });

    await renderAndSettle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'nexus-asset://ws/?path=D%3A%2Fvault%2Fassets%2Fspec.docx'
    );

    // 第二个参数显式带 `convertImage` —— 这是 CSP 里 `img-src ... data:` 的由来，
    // 依赖必须能在调用点被看见，而不是藏在 mammoth 的默认值里。
    const options = convertToHtmlMock.mock.calls[0]?.[1] as { convertImage?: unknown };
    expect(options?.convertImage).toBeDefined();
  });

  it('加载中显示进度态，且宿主元素已在位（否则转换完成时 ref 还是 null）', () => {
    stubFetchOk();
    convertToHtmlMock.mockReturnValue(createPendingConversion().promise);

    renderDocx();

    expect(container.querySelector('.nexus-loading-spinner')).not.toBeNull();
    // 宿主必须**始终**渲染 —— 它跟着状态条件渲染的话，转换完成时拿不到 ref，
    // 内容就永远进不了 shadow root。
    expect(container.querySelector('.nexus-docx-content')).not.toBeNull();
    expect(container.querySelector('.nexus-error-card')).toBeNull();
  });

  it('转换结果进 shadow root：自带样式表 + 文档标签，且不外泄到宿主 DOM', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({
      value: '<h1>标题</h1><p>正文</p>',
      messages: []
    });

    await renderAndSettle();

    const root_ = shadow();
    expect(root_).not.toBeNull();
    // 样式表在边界**内** —— 这正是 Shadow DOM 存在的理由：外层的 h1/p 规则
    // 进不来，里面的也出不去。
    expect(root_!.querySelector('style')).not.toBeNull();
    expect(root_!.querySelector('.docx-body h1')?.textContent).toBe('标题');
    expect(root_!.querySelector('.docx-body p')?.textContent).toBe('正文');

    // 宿主 DOM 里**看不到**这些标签：内容没有污染 App 的选择器空间
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('p')).toBeNull();
  });

  it('空文档给出空态而不是一张空白纸', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({ value: '   ', messages: [] });

    await renderAndSettle();

    expect(container.querySelector('.nexus-state-text')?.textContent).toBeTruthy();
    expect(container.querySelector('.nexus-error-card')).toBeNull();
    // 空态判据是 `html.trim() === ''`，但写进 shadow root 的仍是**原文** ——
    // 渲染器不做二次加工，所以这里断言的是 trim 之后为空。
    expect(shadow()?.querySelector('.docx-body')?.textContent?.trim()).toBe('');
  });

  it('资源取不到时出错误卡，并给出路径 —— 那是用户唯一能据以行动的信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }))
    );

    await renderAndSettle();

    const card = container.querySelector('.nexus-error-card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('alert');
    expect(container.querySelector('.nexus-docx-error-path')?.textContent).toBe(DOC.path);
    // 失败之后不该还在转圈
    expect(container.querySelector('.nexus-loading-spinner')).toBeNull();
  });

  it('mammoth 抛错同样落错误卡，而不是把异常漏给整棵树', async () => {
    stubFetchOk();
    const pending = createPendingConversion();
    convertToHtmlMock.mockReturnValue(pending.promise);

    renderDocx();
    await act(async () => {
      pending.reject(new Error('not a docx'));
      await Promise.resolve();
    });

    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
  });

  it('mammoth 的 warning 计数上界面 —— 沉默丢掉内容是最糟的选项', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({
      value: '<p>正文</p>',
      messages: [
        { type: 'warning', message: 'a' },
        { type: 'warning', message: 'b' },
        // error 类不计入 —— 它是「转换没做成」，会走 reject 那条路；
        // 这里混一条是为了钉住「只数 warning」
        { type: 'error', message: 'c' }
      ]
    });

    await renderAndSettle();

    expect(noticeWarnings()).toBe('2');
  });

  it('没有 warning 时计数为 0，提示退回常驻的保真度说明', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({ value: '<p>正文</p>', messages: [] });

    await renderAndSettle();

    expect(noticeWarnings()).toBe('0');
  });

  it('shadow root 里的链接被拦下 —— 只读预览器没有地址栏，导航走就回不来', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({
      value: '<p><a href="https://example.com">外链</a></p>',
      messages: []
    });

    await renderAndSettle();

    const anchor = shadow()!.querySelector('a');
    expect(anchor).not.toBeNull();

    const event = new Event('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('换一份文档就是换一个实例 —— 上一份的转换结果不会挂到下一份上', async () => {
    stubFetchOk();
    convertToHtmlMock.mockResolvedValue({ value: '<p>第一份</p>', messages: [] });
    await renderAndSettle();

    expect(shadow()!.querySelector('p')?.textContent).toBe('第一份');

    const second: ViewerDocumentDescriptor = {
      path: 'D:\\vault\\other.docx',
      name: 'other.docx',
      type: 'docx'
    };
    convertToHtmlMock.mockResolvedValue({ value: '<p>第二份</p>', messages: [] });
    await renderAndSettle(second);

    // 同一个 root 重新渲染（外壳会带 key，这里模拟 key 变化）
    act(() => {
      root.render(<DocxRenderer key={second.path} document={second} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(shadow()!.querySelector('p')?.textContent).toBe('第二份');
  });
});
