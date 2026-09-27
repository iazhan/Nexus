// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerRendererRegistry } from '../src/viewer/registry.js';
import { ViewerSurface } from '../src/viewer/ViewerSurface.js';
import type { ViewerDocumentDescriptor } from '../src/viewer/types.js';

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC: ViewerDocumentDescriptor = {
  path: '/vault/assets/diagram.png',
  name: 'diagram.png',
  type: 'image'
};

/**
 * Viewer 渲染器登记表（P3-05）。
 *
 * 这一层要守住的是**懒加载不变量**（验收第 6 条）：登记是急切的、加载是懒的。
 * 判据就是 `requestedIds()` —— 在渲染任何附件之前它必须为空，
 * 否则 pdfjs-dist / mammoth 那类重包会被无条件拉进入口块，
 * 把 P1-06 换来的 2309KB → 1136KB 收益吃回去。
 */
describe('ViewerRendererRegistry', () => {
  it('未登记的类型返回 undefined —— 外壳据此回落占位页', () => {
    const registry = new ViewerRendererRegistry();

    expect(registry.get('image')).toBeUndefined();
    expect(registry.registeredTypes()).toEqual([]);
  });

  it('登记之后可以查到，且登记本身不触发加载', () => {
    const registry = new ViewerRendererRegistry();
    const load = vi.fn(async () => ({ default: () => null }));

    registry.registerLazy({ type: 'image', load });

    expect(registry.get('image')).toBeDefined();
    // 关键：登记只写下「谁负责哪个类型」，包本体一个字节都还没读
    expect(load).not.toHaveBeenCalled();
    expect(registry.requestedIds()).toEqual([]);
    expect(registry.loadedIds()).toEqual([]);
  });

  it('同一类型重复登记直接抛错，不静默覆盖', () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({ type: 'pdf', load: async () => ({ default: () => null }) });

    // 静默覆盖会让「哪个实现生效」取决于注册顺序，症状是「换了实现但行为没变」
    expect(() =>
      registry.registerLazy({ type: 'pdf', load: async () => ({ default: () => null }) })
    ).toThrow(/already registered/);
  });

  it('registeredTypes 保持登记顺序', () => {
    const registry = new ViewerRendererRegistry();
    const noop = async () => ({ default: () => null });

    registry.registerLazy({ type: 'pdf', load: noop });
    registry.registerLazy({ type: 'docx', load: noop });
    registry.registerLazy({ type: 'image', load: noop });

    expect(registry.registeredTypes()).toEqual(['pdf', 'docx', 'image']);
  });
});

/**
 * Viewer 外壳。
 *
 * 三层职责各自独立：没有渲染器 → 占位页；渲染器在下载 → Suspense 占位；
 * 渲染器抛错 → 错误卡。三者混起来的后果是「一份坏 PDF 让整个窗口白屏」。
 */
describe('ViewerSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('没有渲染器时显示占位页，并如实标出类型与路径', () => {
    const registry = new ViewerRendererRegistry();

    act(() => {
      root.render(<ViewerSurface document={DOC} registry={registry} />);
    });

    const placeholder = container.querySelector('.nexus-viewer-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.getAttribute('data-viewer-type')).toBe('image');
    // 路径是用户判断「打开的是不是我点的那个文件」的唯一依据
    expect(container.querySelector('.nexus-workspace-empty-path')?.textContent).toBe(DOC.path);
    // 占位不是错误：不能出现错误卡
    expect(container.querySelector('.nexus-error-card')).toBeNull();
  });

  it('有渲染器时渲染它，并把文档描述递进去', async () => {
    const registry = new ViewerRendererRegistry();
    const received: ViewerDocumentDescriptor[] = [];
    registry.registerLazy({
      type: 'image',
      load: async () => ({
        default: ({ document }) => {
          received.push(document);
          return <div className="fake-image" />;
        }
      })
    });

    await act(async () => {
      root.render(<ViewerSurface document={DOC} registry={registry} />);
    });

    expect(container.querySelector('.fake-image')).not.toBeNull();
    expect(container.querySelector('.nexus-viewer-placeholder')).toBeNull();
    expect(received).toEqual([DOC]);

    // 渲染过了 → 这个类型的包确实开始下载了。这正是 requestedIds() 的语义。
    expect(registry.requestedIds()).toEqual(['image']);
    expect(registry.loadedIds()).toEqual(['image']);
  });

  it('渲染器抛错时出错误卡，而不是把异常漏给整棵树', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'pdf',
      load: async () => ({
        default: () => {
          throw new Error('pdfjs exploded');
        }
      })
    });

    await act(async () => {
      root.render(
        <ViewerSurface document={{ ...DOC, type: 'pdf', path: '/vault/a.pdf' }} registry={registry} />
      );
    });

    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
    expect(container.textContent).toContain('pdfjs exploded');
    // 兜底生效的最低要求：根节点不能是空的（空 = 整窗白屏）
    expect(container.children.length).toBeGreaterThan(0);
  });

  it('换一份文档会清掉上一份的错误状态', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'pdf',
      load: async () => ({
        default: ({ document }) => {
          if (document.path.endsWith('broken.pdf')) throw new Error('bad file');
          return <div className="good-pdf" />;
        }
      })
    });

    await act(async () => {
      root.render(
        <ViewerSurface
          document={{ ...DOC, type: 'pdf', path: '/vault/broken.pdf' }}
          registry={registry}
        />
      );
    });
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();

    // resetKey 绑文档路径：否则一份坏 PDF 会让之后每一份 PDF 都显示同一张错误卡
    await act(async () => {
      root.render(
        <ViewerSurface
          document={{ ...DOC, type: 'pdf', path: '/vault/ok.pdf' }}
          registry={registry}
        />
      );
    });

    expect(container.querySelector('.nexus-error-card')).toBeNull();
    expect(container.querySelector('.good-pdf')).not.toBeNull();
  });
});
