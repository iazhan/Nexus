// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ImageRenderer from '../src/viewer/image/ImageRenderer.js';
import type { ViewerDocumentDescriptor } from '../src/viewer/types.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC: ViewerDocumentDescriptor = {
  path: 'D:\\vault\\assets\\diagram.png',
  name: 'diagram.png',
  type: 'image',
  page: null,
  citationBase: 'D:////vault'
};

/**
 * 图片渲染器（P3-06）。
 *
 * 这里验的是**渲染器自己的三个状态**：加载中/成功/失败，以及它交给浏览器的 URL。
 * 「真实 PNG 能不能解码、尺寸对不对、CSP 放不放行」在 `p3-06-image-viewer.test.ts`
 * 里用真 Electron + 真文件验 —— happy-dom 不会真的解码图片，在它上面断言尺寸
 * 只会测到我自己塞进去的数字。
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
  });

  /** 渲染并返回当前的 `<img>`；没有则返回 null。 */
  const renderImage = (doc: ViewerDocumentDescriptor = DOC): HTMLImageElement | null => {
    act(() => {
      root.render(<ImageRenderer document={doc} />);
    });
    return container.querySelector('img');
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

  it('换一份文档就是换一个实例 —— 上一张的尺寸不会挂到下一张上', () => {
    // 这条断言的是**宿主必须给 key** 这个契约（见 ViewerSurface 的 `key={doc.path}`）：
    // 组件本身没有「按路径重置状态」的逻辑，靠的是换 key 换实例。
    // 这里模拟宿主的做法：换 key 重新挂载。
    const first = renderImage();
    fireLoad(first!, 640, 480);
    expect(container.querySelector('.nexus-image-size')?.textContent).toBe('640 × 480');

    const next: ViewerDocumentDescriptor = {
      path: 'D:\\vault\\assets\\other.png',
      name: 'other.png',
      type: 'image'
    };
    act(() => {
      root.render(<ImageRenderer key={next.path} document={next} />);
    });

    expect(container.querySelector('.nexus-image-size')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('other.png');
  });
});
