// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageRenderer from '../src/viewer/image/ImageRenderer.js';
import type { ViewerDocumentDescriptor } from '../src/viewer/types.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 工作区模式：`citationBase` 是**工作区根**，所以相对路径（`assets/diagram.png`）
 * 比文件名长，那条「与文件名相同就不显示」的判据在它上面走 false 这一支。
 * 轻量模式那一支见「相对路径与文件名相同时不显示」那条用例。
 */
const DOC: ViewerDocumentDescriptor = {
  path: 'D:\\vault\\assets\\diagram.png',
  name: 'diagram.png',
  type: 'image',
  page: null,
  citationBase: 'D:\\vault'
};

/**
 * 图片渲染器（P3-06 / 浏览能力增强）。
 *
 * 这里验的是**渲染器自己的状态与判据**：加载中/成功/失败、交给浏览器的 URL、
 * 信息面板三项（相对路径 / 像素尺寸 / 文件大小）、缩放档位与光标锚点。
 * 「真实 PNG 能不能解码、CSS 有没有真的把图放大、滚动条滚不滚得动」在
 * `p3-06-image-viewer.test.ts` 里用真 Electron + 真文件验 —— happy-dom 不做布局，
 * `clientWidth` / `offsetWidth` / `getBoundingClientRect` 全是 0，
 * 在它上面断言真实尺寸只会测到我塞进去的数字。
 *
 * 断言刻意**不依赖文案**（i18n 默认语言受环境影响），错误态断言的是**路径**：
 * 那也是用户唯一能据以行动的信息（是哪个文件加载失败了）。
 */
describe('ImageRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const stage = (): HTMLElement => container.querySelector<HTMLElement>('.nexus-image-stage')!;
  const renderedImage = (): HTMLImageElement =>
    container.querySelector<HTMLImageElement>('.nexus-image-content')!;
  const zoomInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('.nexus-image-zoom-level')!;
  const actionButton = (action: 'fit' | 'actual'): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-zoom-action="${action}"]`)!;

  /** 渲染并返回当前的 `<img>`；没有则返回 null。 */
  const renderImage = (doc: ViewerDocumentDescriptor = DOC): HTMLImageElement | null => {
    act(() => {
      root.render(<ImageRenderer document={doc} />);
    });
    return container.querySelector('img');
  };

  /**
   * 渲染 + 让图片「解码完成」。
   *
   * `stageSize` 必须在 `onLoad` **之前**设好 —— 打开即「适合窗口」那一步就在
   * `onLoad` 里算，而它要量 stage。happy-dom 不做布局，所以这里显式给一组数字。
   */
  const loadImage = (
    width: number,
    height: number,
    stageSize?: { width: number; height: number }
  ): HTMLImageElement => {
    const img = renderImage()!;
    if (stageSize !== undefined) {
      Object.defineProperty(stage(), 'clientWidth', {
        configurable: true,
        value: stageSize.width
      });
      Object.defineProperty(stage(), 'clientHeight', {
        configurable: true,
        value: stageSize.height
      });
    }
    fireLoad(img, width, height);
    return img;
  };

  /** 渲染并等异步 effect（取文件大小）落定。 */
  const renderAndSettle = async (doc: ViewerDocumentDescriptor = DOC): Promise<void> => {
    renderImage(doc);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  /**
   * 让 `fetch` 对 HEAD 返回一个 `content-length`。
   *
   * 只造 `headers.get` 这一个接口，不造真的 `Response` —— 渲染器只用得到它，
   * 而 happy-dom 的 `Response` 支持程度不值得赌。
   */
  const stubContentLength = (value: string | null): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        headers: { get: (name: string) => (name === 'content-length' ? value : null) }
      }))
    );
  };

  /** 图片解码完成：`naturalWidth/Height` 是只读的，测试里直接定义出来。 */
  const fireLoad = (img: HTMLImageElement, width: number, height: number): void => {
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  };

  const fireError = (img: HTMLImageElement): void => {
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
  };

  const click = (element: HTMLElement): void => {
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  /** 受控输入：直接改 `value` 不会触发 React 的 onChange，要走原型上的 setter。 */
  const typeInto = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const pressKey = (element: HTMLElement, key: string): void => {
    act(() => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    });
  };

  const zoomButtons = (): { out: HTMLButtonElement; in: HTMLButtonElement } => {
    const buttons = container.querySelectorAll<HTMLButtonElement>('.nexus-image-zoom-button');
    return { out: buttons[0]!, in: buttons[1]! };
  };

  /**
   * 造一个滚轮事件。
   *
   * **happy-dom 的 `WheelEvent` 只认 `deltaY`** —— `ctrlKey` / `clientX` / `clientY` 从 init
   * 里读出来是 `undefined`（实测，同 `pdf-renderer.test.tsx` 里那条）。不补的话处理器
   * 会在第一行 `!event.ctrlKey` 就返回，用例绿得毫无意义。
   */
  const makeWheel = (init: {
    deltaY: number;
    ctrlKey?: boolean;
    clientX?: number;
    clientY?: number;
  }): WheelEvent => {
    const event = new WheelEvent('wheel', {
      deltaY: init.deltaY,
      bubbles: true,
      cancelable: true
    });
    Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false });
    Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 });
    Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0 });
    return event;
  };

  const wheelOnStage = async (event: WheelEvent): Promise<void> => {
    act(() => {
      stage().dispatchEvent(event);
    });
    // 滚动位置的对齐在 `requestAnimationFrame` 里落地（新尺寸还没进 DOM 时量到的是旧的）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };

  /**
   * 给 stage 与图片一组「实测几何」。
   *
   * `offsetWidth` 刻意**跟着 `style.width` 走** —— 真实浏览器里缩放就是这么生效的，
   * 写死一个常量的话「缩放后按新宽度重算滚动位置」这条逻辑就测不出来了。
   */
  const stubImageGeometry = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): { scrollLeft: () => number; scrollTop: () => number } => {
    const image = renderedImage();
    let scrollLeft = 0;
    let scrollTop = 0;

    const box = (left: number, top: number, width: number, height: number): DOMRect =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({})
      }) as DOMRect;

    Object.defineProperty(image, 'getBoundingClientRect', {
      configurable: true,
      value: () => box(rect.left, rect.top, rect.width, rect.height)
    });
    Object.defineProperty(stage(), 'getBoundingClientRect', {
      configurable: true,
      value: () => box(0, 0, 1000, 700)
    });
    Object.defineProperty(image, 'offsetWidth', {
      configurable: true,
      get: () => parseFloat(image.style.width) || rect.width
    });
    Object.defineProperty(image, 'offsetHeight', {
      configurable: true,
      get: () => parseFloat(image.style.height) || rect.height
    });
    Object.defineProperty(stage(), 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      }
    });
    Object.defineProperty(stage(), 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    });

    return { scrollLeft: () => scrollLeft, scrollTop: () => scrollTop };
  };

  it('把路径转成 nexus-asset:// URL 交给浏览器，alt 用文件名', () => {
    const img = renderImage();

    expect(img).not.toBeNull();
    // 走 nexus-asset:// 而不是 file:// —— http 页面（dev）加载不了 file:// 子资源，
    // 而 CSP 管不了那条浏览器策略。详见 asset-url.ts 的文件头注释。
    expect(img!.getAttribute('src')).toBe(
      'nexus-asset://ws/?path=D%3A%2Fvault%2Fassets%2Fdiagram.png'
    );
    // alt 是图片没显示出来时的唯一信息
    expect(img!.getAttribute('alt')).toBe('diagram.png');
    // 外层与 stage 是布局锚点，E2E 与样式都靠它们
    expect(container.querySelector('.nexus-image-viewer')).not.toBeNull();
    expect(container.querySelector('.nexus-image-stage')).not.toBeNull();
  });

  it('解码完成前不显示尺寸 —— 显示 0 × 0 比什么都不显示更误导', () => {
    const img = renderImage();
    expect(container.querySelector('.nexus-image-size')).toBeNull();

    fireLoad(img!, 640, 480);

    expect(container.querySelector('.nexus-image-size')?.textContent).toBe('640 × 480');
  });

  it('尺寸取真实像素，不取受 CSS 缩放影响的显示尺寸', () => {
    const img = renderImage();

    // 真实像素与显示尺寸刻意取不同值：断言写错就会读到 800×600 而不是 3200×2400
    fireLoad(img!, 3200, 2400);
    Object.defineProperty(img!, 'width', { value: 800, configurable: true });
    Object.defineProperty(img!, 'height', { value: 600, configurable: true });

    expect(container.querySelector('.nexus-image-size')?.textContent).toBe('3200 × 2400');
  });

  it('加载失败时出错误卡并给出路径，且不再留着破图占位', () => {
    const img = renderImage();
    fireError(img!);

    expect(container.querySelector('.nexus-image-viewer')).toBeNull();
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
    // 路径是用户唯一能据以行动的信息：是哪个文件没了
    expect(container.querySelector('.nexus-image-error-path')?.textContent).toBe(DOC.path);
  });

  it('失败后不再重试同一张图 —— 状态是终态，不来回闪', () => {
    const img = renderImage();
    fireError(img!);
    fireError(img!);

    expect(container.querySelectorAll('.nexus-error-card')).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
  });

  it('换一份文档就是换一个实例 —— 上一张的尺寸与缩放不会挂到下一张上', () => {
    // 这条断言的是**宿主必须给 key** 这个契约（见 ViewerSurface 的 `key={doc.path}`）：
    // 组件本身没有「按路径重置状态」的逻辑，靠的是换 key 换实例。
    // 这里模拟宿主的做法：换 key 重新挂载。
    const first = renderImage();
    fireLoad(first!, 640, 480);
    click(zoomButtons().in);
    expect(container.querySelector('.nexus-image-size')?.textContent).toBe('640 × 480');
    expect(zoomInput().value).toBe('125');

    const next: ViewerDocumentDescriptor = {
      path: 'D:\\vault\\assets\\other.png',
      name: 'other.png',
      type: 'image',
      page: null,
      citationBase: 'D:\\vault'
    };
    act(() => {
      root.render(<ImageRenderer key={next.path} document={next} />);
    });

    expect(container.querySelector('.nexus-image-size')).toBeNull();
    expect(zoomInput().value).toBe('100');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('other.png');
  });

  it('相对路径相对工作区根显示，分隔符统一成 `/`', async () => {
    await renderAndSettle();

    expect(container.querySelector('.nexus-image-path')?.textContent).toBe('assets/diagram.png');
  });

  it('相对路径与文件名相同时不显示 —— 轻量模式下算出来就是文件名', async () => {
    // 轻量模式：`citationBase` 是文档所在目录，算出来与 `name` 逐字相同。
    // 多显示一遍只是噪声（左边那个名字已经在同一行了）。
    await renderAndSettle({
      path: 'D:\\shots\\diagram.png',
      name: 'diagram.png',
      type: 'image',
      page: null,
      citationBase: 'D:\\shots'
    });

    expect(container.querySelector('.nexus-image-path')).toBeNull();
    // 但尺寸与大小照常 —— 「路径不显示」不该顺带把别的也关掉
    expect(container.querySelector('.nexus-image-name')?.textContent).toBe('diagram.png');
  });

  it('文件大小取自资源通道 HEAD 的 content-length，并格式化成人读的单位', async () => {
    stubContentLength('1536');
    await renderAndSettle();

    expect(container.querySelector('.nexus-image-bytes')?.textContent).toBe('1.5 KB');
  });

  it('取不到文件大小就静默降级 —— 不显示，也不影响其它信息', async () => {
    // 通道不可用（协议没注册、主进程没应答）时 `fetch` 会抛
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('unsupported protocol');
      })
    );
    await renderAndSettle();

    expect(container.querySelector('.nexus-image-bytes')).toBeNull();
    // 关键：失败不升级成错误卡 —— 大小是锦上添花，图本身照样看得见
    expect(container.querySelector('.nexus-error-card')).toBeNull();
    expect(container.querySelector('.nexus-image-viewer')).not.toBeNull();
  });

  it('content-length 缺失或不是数字时不显示大小', async () => {
    stubContentLength(null);
    await renderAndSettle();
    expect(container.querySelector('.nexus-image-bytes')).toBeNull();

    stubContentLength('not-a-number');
    await renderAndSettle();
    expect(container.querySelector('.nexus-image-bytes')).toBeNull();
  });

  describe('缩放', () => {
    it('打开即「适合窗口」—— 4000px 的照片不该按 100% 只露出四分之一', () => {
      loadImage(4000, 3000, { width: 1200, height: 700 });

      // min(1200/4000, 700/3000) = 0.2333… → 显示 23%
      expect(zoomInput().value).toBe('23');
    });

    it('「适合窗口」与「实际大小」是两个动作，100% 不是默认态', () => {
      loadImage(4000, 3000, { width: 1200, height: 700 });
      expect(zoomInput().value).toBe('23');

      click(actionButton('actual'));
      expect(zoomInput().value).toBe('100');

      click(actionButton('fit'));
      expect(zoomInput().value).toBe('23');
    });

    it('`+` / `−` 走一档，且**渲染尺寸**跟着变（不是只改数字）', () => {
      const img = loadImage(800, 600, { width: 1200, height: 700 });
      click(actionButton('actual'));
      expect(img.style.width).toBe('800px');

      click(zoomButtons().in);
      expect(zoomInput().value).toBe('125');
      expect(img.style.width).toBe('1000px');

      click(zoomButtons().out);
      expect(zoomInput().value).toBe('100');
      expect(img.style.width).toBe('800px');
    });

    it('到上限 / 下限后按钮禁用 —— 靠 `disabled` 判定边界，视觉与行为必须一致', () => {
      loadImage(800, 600, { width: 1200, height: 700 });

      expect(zoomButtons().out.disabled).toBe(false);
      expect(zoomButtons().in.disabled).toBe(false);

      typeInto(zoomInput(), '300');
      pressKey(zoomInput(), 'Enter');
      expect(zoomButtons().in.disabled).toBe(true);
      expect(zoomButtons().out.disabled).toBe(false);

      typeInto(zoomInput(), '10');
      pressKey(zoomInput(), 'Enter');
      expect(zoomButtons().out.disabled).toBe(true);
      expect(zoomButtons().in.disabled).toBe(false);
    });

    it('缩放比例可直接编辑：回车提交、越界夹紧、非数字保持原值', () => {
      loadImage(800, 600, { width: 1200, height: 700 });

      typeInto(zoomInput(), '200');
      pressKey(zoomInput(), 'Enter');
      expect(zoomInput().value).toBe('200');

      // 越界夹到上限，且**草稿被写回** —— 否则框里一直停着用户敲的 999
      typeInto(zoomInput(), '999');
      pressKey(zoomInput(), 'Enter');
      expect(zoomInput().value).toBe('300');

      typeInto(zoomInput(), 'abc');
      pressKey(zoomInput(), 'Enter');
      expect(zoomInput().value).toBe('300');
    });

    it('Escape 取消编辑，回到当前值', () => {
      loadImage(800, 600, { width: 1200, height: 700 });
      // 打开即「适合窗口」：min(1200/800, 700/600) = 1.1667 → 117
      expect(zoomInput().value).toBe('117');

      typeInto(zoomInput(), '250');
      pressKey(zoomInput(), 'Escape');
      expect(zoomInput().value).toBe('117');
    });

    it('缩放不改 naturalWidth —— 信息面板报的永远是文件真实像素', () => {
      const img = loadImage(800, 600, { width: 1200, height: 700 });
      const before = img.naturalWidth;

      click(zoomButtons().in);
      click(zoomButtons().in);

      expect(img.naturalWidth).toBe(before);
      expect(container.querySelector('.nexus-image-size')?.textContent).toBe('800 × 600');
    });

    it('解码前两个缩放动作都不可用 —— 还不知道原尺寸，算了也是错的', () => {
      renderImage();

      expect(actionButton('fit').disabled).toBe(true);
      expect(actionButton('actual').disabled).toBe(true);
    });
  });

  describe('滚轮缩放与平移', () => {
    it('Ctrl + 滚轮缩放，并把光标下那一点放回原处', async () => {
      loadImage(800, 600, { width: 1000, height: 700 });
      click(actionButton('actual'));
      const geometry = stubImageGeometry({ left: 100, top: 50, width: 800, height: 600 });

      await wheelOnStage(makeWheel({ deltaY: -400, ctrlKey: true, clientX: 700, clientY: 200 }));

      const width = parseFloat(renderedImage().style.width);
      expect(width).toBeGreaterThan(800);
      // 不变量：光标下的相对位置（(700-100)/800 = 0.75）缩放后仍落在光标的 x 上
      expect(0.75 * width - geometry.scrollLeft()).toBeCloseTo(700, 5);
    });

    it('不按修饰键的滚轮只滚动 —— 抢掉它等于把「翻看长图」变成「什么都做不了」', async () => {
      loadImage(800, 600, { width: 1000, height: 700 });
      click(actionButton('actual'));

      await wheelOnStage(makeWheel({ deltaY: -400, clientX: 700, clientY: 200 }));

      expect(zoomInput().value).toBe('100');
    });

    it('到上限后仍然拦住滚轮 —— 否则那几下会穿透成整个界面的缩放', () => {
      loadImage(800, 600, { width: 1000, height: 700 });
      typeInto(zoomInput(), '300');
      pressKey(zoomInput(), 'Enter');

      const event = makeWheel({ deltaY: -400, ctrlKey: true, clientX: 400, clientY: 300 });
      act(() => {
        stage().dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(zoomInput().value).toBe('300');
    });

    it('一帧里连滚两格，两格都算数 —— 第二格必须基于第一格的结果', async () => {
      loadImage(800, 600, { width: 1000, height: 700 });
      click(actionButton('actual'));
      stubImageGeometry({ left: 0, top: 0, width: 800, height: 600 });

      // 两次派发**不 await**：`setZoom` 还没提交，第二次滚轮必须从 `zoomRef` 读到
      // 第一格的结果。只读 state 的话第二格会算出与第一格相同的值，连滚两格只放大一格。
      const target = stage();
      act(() => {
        target.dispatchEvent(
          makeWheel({ deltaY: -120, ctrlKey: true, clientX: 400, clientY: 300 })
        );
        target.dispatchEvent(
          makeWheel({ deltaY: -120, ctrlKey: true, clientX: 400, clientY: 300 })
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // 一格 exp(0.12) ≈ 1.1275，两格 ≈ 1.2712 → 显示 127（不是 113）
      expect(zoomInput().value).toBe('127');
    });

    it('缩放把滚动位置夹回合法范围 —— 不留滚不动的偏移', async () => {
      loadImage(800, 600, { width: 1000, height: 700 });
      click(actionButton('actual'));
      const geometry = stubImageGeometry({ left: 0, top: 0, width: 800, height: 600 });
      Object.defineProperty(stage(), 'scrollWidth', { configurable: true, value: 4000 });
      Object.defineProperty(stage(), 'clientWidth', { configurable: true, value: 1000 });

      await wheelOnStage(makeWheel({ deltaY: -400, ctrlKey: true, clientX: 400, clientY: 300 }));

      // 4000 - 1000 = 3000 是上限；算出来小于它时保持原值，大于它时被夹住
      expect(geometry.scrollLeft()).toBeLessThanOrEqual(3000);
      expect(geometry.scrollLeft()).toBeGreaterThanOrEqual(0);
    });
  });
});
