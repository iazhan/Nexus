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

  it('listRenderers 列出全部已登记渲染器及其原始状态位', () => {
    const registry = new ViewerRendererRegistry();
    const load = vi.fn(async () => ({ default: () => null }));
    registry.registerLazy({ type: 'image', load });
    registry.registerLazy({ type: 'pdf', load });

    // 与 requestedIds() / loadedIds() 的区别就在这里：那两个只覆盖「已经开始 / 已完成」的，
    // 能力清单要连「登记了但从没打开过该类型文档」的也列出来 —— 那是用户最需要看见的一档。
    expect(registry.listRenderers()).toEqual([
      { type: 'image', requested: false, loaded: false, failed: false, disabled: false },
      { type: 'pdf', requested: false, loaded: false, failed: false, disabled: false }
    ]);
    // 登记仍然不触发加载：状态位是读出来的，不是走一遍加载换来的
    expect(load).not.toHaveBeenCalled();
  });

  /**
   * 启停。谓词是**注入的**、且**每次查表时求值** —— 于是改设置立即生效：
   * 不用重新登记（`registerLazy` 对重复类型是抛错的）、不用重启。
   *
   * 反面判据不能省：只断言「被关掉的查不到」对「把什么都查不到」同样成立。
   */
  describe('启停', () => {
    it('被关掉的类型查不到，同表里没被关的照常查到', () => {
      const registry = new ViewerRendererRegistry((id) => id !== 'pdf');
      const load = async () => ({ default: () => null });
      registry.registerLazy({ type: 'pdf', load });
      registry.registerLazy({ type: 'docx', load });

      expect(registry.get('pdf')).toBeUndefined();
      expect(registry.isCapabilityEnabled('pdf')).toBe(false);
      // 关掉一个不能连累另一个 —— 否则「PDF 关了、DOCX 也打不开」也能过上面那条
      expect(registry.get('docx')).toBeDefined();
      expect(registry.isCapabilityEnabled('docx')).toBe(true);
    });

    it('改谓词立即生效，不用重新登记', () => {
      let disabled = false;
      const registry = new ViewerRendererRegistry(() => !disabled);
      registry.registerLazy({ type: 'pdf', load: async () => ({ default: () => null }) });

      expect(registry.get('pdf')).toBeDefined();

      disabled = true;
      expect(registry.get('pdf')).toBeUndefined();
      expect(registry.listRenderers()).toEqual([
        { type: 'pdf', requested: false, loaded: false, failed: false, disabled: true }
      ]);

      // 再打开：登记表一个字节都没动过，只是谓词换了答案
      disabled = false;
      expect(registry.get('pdf')).toBeDefined();
    });
  });
});

/**
 * 状态订阅。
 *
 * 渲染器的状态位是在 `React.lazy` 的工厂里翻的，而工厂只在组件**第一次渲染**时被调用 ——
 * 也就是说状态变化总是发生在渲染过程中。同步通知会撞上 React 的「渲染期间更新另一个组件」，
 * 所以通知必须推迟一拍（由 `createChangeNotifier` 负责）。
 *
 * 两条判据一正一反：**送达时状态位已经翻转**（否则能力清单读到旧值、停在「未加载」），
 * 以及**退订之后不再被叫醒**（否则是泄漏）。
 */
describe('ViewerRendererRegistry 状态订阅', () => {
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

  /** 登记一个能立刻加载完的渲染器，并渲染一次触发工厂。 */
  const renderOnce = async (registry: ViewerRendererRegistry) => {
    await act(async () => {
      root.render(<ViewerSurface document={DOC} registry={registry} />);
      // 让 `queueMicrotask` 排下的那一拍（以及紧随其后的 import 完成）跑完
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('送达时状态位已经翻转 —— 订阅方读到的是新值', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'image',
      load: async () => ({ default: () => <div className="fake-image" /> })
    });

    const seen: Array<{ requested: boolean; loaded: boolean }> = [];
    registry.subscribe(() => {
      const renderer = registry.listRenderers().find((r) => r.type === 'image')!;
      seen.push({ requested: renderer.requested, loaded: renderer.loaded });
    });

    await renderOnce(registry);

    expect(seen.length).toBeGreaterThan(0);
    // 中间态也要报：能力清单的「加载中」靠它
    expect(seen).toContainEqual({ requested: true, loaded: false });
    // 最后送达的一拍是终态；若通知发在位翻转之前，这里会是 loaded: false
    expect(seen.at(-1)).toEqual({ requested: true, loaded: true });
  });

  it('退订之后不再被叫醒 —— 反面判据：不解除就是泄漏', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'image',
      load: async () => ({ default: () => <div className="fake-image" /> })
    });

    const listener = vi.fn();
    registry.subscribe(listener)();

    await renderOnce(registry);

    expect(listener).not.toHaveBeenCalled();
    // 但状态照常推进：退订只影响「谁被叫醒」，不影响记账
    expect(registry.loadedIds()).toEqual(['image']);
  });
});

/**
 * Viewer 外壳。
 *
 * 四档互不相同的结局：没有渲染器 → 占位页；渲染器在下载 → Suspense 占位；
 * **渲染器的包没下载下来 → 「插件不可用」卡**；渲染器渲染时崩 → 默认错误卡
 * （带原始异常与重试）。混起来的后果是「一份坏 PDF 让整个窗口白屏」。
 *
 * 后两档都经过 `ErrorBoundary`（`React.lazy` 的 reject 只能由边界接），靠
 * `fallback` 读注册表的 `hasFailed` 分岔 —— 所以这里必须**同时**断言另一档不出现，
 * 否则「把所有失败都画成同一张卡」也能过。
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

    // 包加载成功、渲染时崩 —— 那是「这份文件有问题」，不是「插件没加载上」，
    // 所以仍然走默认卡（带原始异常与重试）。
    expect(container.querySelector('.nexus-error-card')).not.toBeNull();
    expect(container.textContent).toContain('pdfjs exploded');
    expect(container.querySelector('.nexus-viewer-unavailable')).toBeNull();
    // 兜底生效的最低要求：根节点不能是空的（空 = 整窗白屏）
    expect(container.children.length).toBeGreaterThan(0);
  });

  it('渲染器包下载失败时显示「插件不可用」，而不是原始异常卡', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'pdf',
      load: async () => {
        throw new Error('Failed to fetch dynamically imported module: /assets/PdfRenderer-x.js');
      }
    });

    await act(async () => {
      root.render(
        <ViewerSurface document={{ ...DOC, type: 'pdf', path: '/vault/a.pdf' }} registry={registry} />
      );
    });

    const card = container.querySelector('.nexus-viewer-unavailable');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('data-viewer-type')).toBe('pdf');
    // 是错误不是空态，读屏要能播报
    expect(card!.getAttribute('role')).toBe('alert');
    // 用户要知道是哪一份文件没打开成功
    expect(container.querySelector('.nexus-workspace-empty-path')?.textContent).toBe('/vault/a.pdf');

    // 给用户看的文案，不是给排查问题的人看的原始异常
    expect(container.textContent).not.toContain('Failed to fetch');
    expect(container.querySelector('.nexus-error-card')).toBeNull();
    // 也不该给一个点了没反应的「重试」：失败的 React.lazy 会把那次 reject 永久缓存在
    // 组件实例上，本进程内重试必然再抛同一个错（有入口却无反馈）。
    expect(container.querySelector('.nexus-retry-btn')).toBeNull();

    // 登记表记下了这次失败 —— 能力清单据此显示 failed，而不是永远转圈
    expect(registry.listRenderers()).toEqual([
      { type: 'pdf', requested: true, loaded: false, failed: true, disabled: false }
    ]);
  });

  /**
   * 「没人渲染」有两种，两张卡。
   *
   * 一条正一条反：关掉的那份出**「已禁用」**卡，而同一次渲染里**没被关掉**的那份照常
   * 渲染 —— 只断言「出现了已禁用卡」对「把所有类型都画成已禁用」同样成立。
   */
  it('被关掉的类型出「已禁用」卡，而不是「尚未接入」卡', async () => {
    const registry = new ViewerRendererRegistry((id) => id !== 'pdf');
    registry.registerLazy({
      type: 'pdf',
      load: async () => ({ default: () => <div className="fake-pdf" /> })
    });

    await act(async () => {
      root.render(
        <ViewerSurface document={{ ...DOC, type: 'pdf', path: '/vault/a.pdf' }} registry={registry} />
      );
    });

    const card = container.querySelector('.nexus-viewer-disabled');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('data-viewer-type')).toBe('pdf');
    // 用户要知道是哪一份文件没打开
    expect(container.querySelector('.nexus-workspace-empty-path')?.textContent).toBe('/vault/a.pdf');
    // 它不是「这个构建里没有这个渲染器」—— 那是另一回事，另一张卡
    expect(container.querySelector('.nexus-viewer-placeholder')).toBeNull();
    // 也不该去加载那个包：关掉的意义之一就是它的 chunk 一个字节都不下载
    expect(registry.requestedIds()).toEqual([]);
    expect(registry.listRenderers()).toEqual([
      { type: 'pdf', requested: false, loaded: false, failed: false, disabled: true }
    ]);
  });

  it('没被关掉的类型照常渲染 —— 反面：别把「关了 pdf」做成「附件都打不开」', async () => {
    const registry = new ViewerRendererRegistry((id) => id !== 'pdf');
    registry.registerLazy({
      type: 'pdf',
      load: async () => ({ default: () => <div className="fake-pdf" /> })
    });
    registry.registerLazy({
      type: 'image',
      load: async () => ({ default: () => <div className="fake-image" /> })
    });

    await act(async () => {
      root.render(<ViewerSurface document={DOC} registry={registry} />);
    });

    expect(container.querySelector('.fake-image')).not.toBeNull();
    expect(container.querySelector('.nexus-viewer-disabled')).toBeNull();
    expect(container.querySelector('.nexus-viewer-placeholder')).toBeNull();
  });

  it('一个渲染器失败不影响另一个 —— 反面：不能把所有渲染器都标成失败', async () => {
    const registry = new ViewerRendererRegistry();
    registry.registerLazy({
      type: 'pdf',
      load: async () => {
        throw new Error('chunk load failed');
      }
    });
    registry.registerLazy({
      type: 'image',
      load: async () => ({ default: () => <div className="fake-image" /> })
    });

    await act(async () => {
      root.render(
        <ViewerSurface document={{ ...DOC, type: 'pdf', path: '/vault/a.pdf' }} registry={registry} />
      );
    });
    expect(container.querySelector('.nexus-viewer-unavailable')).not.toBeNull();

    // 换到正常的那一份：错误卡必须清掉，渲染器照常跑
    await act(async () => {
      root.render(<ViewerSurface document={DOC} registry={registry} />);
    });
    expect(container.querySelector('.fake-image')).not.toBeNull();
    expect(container.querySelector('.nexus-viewer-unavailable')).toBeNull();
    expect(container.querySelector('.nexus-error-card')).toBeNull();

    expect(registry.listRenderers()).toEqual([
      { type: 'pdf', requested: true, loaded: false, failed: true, disabled: false },
      { type: 'image', requested: true, loaded: true, failed: false, disabled: false }
    ]);
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
