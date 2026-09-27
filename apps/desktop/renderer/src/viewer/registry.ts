import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ViewerDocumentType } from '@nexus/core';
import type { ViewerRendererModule, ViewerRendererProps } from './types.js';

/** 注册一个渲染器：声明它负责哪个类型，以及怎么把包 import 回来。 */
export interface ViewerRendererRegistration {
  readonly type: ViewerDocumentType;
  /**
   * 动态 import 工厂。
   *
   * 必须写成 `() => import('...')` 的形式（**不能**在注册处先 import 再包一层），
   * 否则 pdfjs-dist / mammoth 会跟着入口块一起进主包 —— 那正是 P1-06 花了
   * 2309KB → 1136KB 换来的收益（§7 第 9 条，验收第 6 条）。
   */
  readonly load: () => Promise<ViewerRendererModule>;
}

/**
 * 一个按需加载的渲染器。
 *
 * 与 `packages/editor` 的 `LazyExtension` 是同一套形状（§7 第 9 条要求
 * 「沿用 P1-06 的机制」）：**登记是急切的、加载是懒的**。宿主在启动时就知道
 * 「png 归谁、pdf 归谁」，但那个包的 chunk 要等真的渲染第一个该类型文档才下载。
 *
 * 用 `React.lazy` 而不是自己管 import 状态，是因为它恰好提供了我们需要的时机：
 * 工厂只在组件**第一次渲染**时被调用 —— 于是 `requested` 为真 ⟺ 该 chunk
 * 已经开始下载，`requestedIds()` 因此可以直接当作懒加载判据。
 */
class LazyViewerRenderer {
  private wasRequested = false;
  private resolved = false;
  private failed = false;
  private readonly lazyComponent: LazyExoticComponent<ComponentType<ViewerRendererProps>>;

  constructor(
    readonly type: ViewerDocumentType,
    load: () => Promise<ViewerRendererModule>
  ) {
    this.lazyComponent = lazy(async () => {
      this.wasRequested = true;
      try {
        const module = await load();
        this.resolved = true;
        return module;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
  }

  /** 挂到 `<Suspense>` 下的组件。 */
  get component(): ComponentType<ViewerRendererProps> {
    return this.lazyComponent;
  }

  /** `import()` 是否已经发起 —— 即这个渲染器的 chunk 是否开始下载。 */
  get requested(): boolean {
    return this.wasRequested;
  }

  /** 包是否已经 import 回来。 */
  get loaded(): boolean {
    return this.resolved;
  }

  /** 上一次加载是否失败。 */
  get hasFailed(): boolean {
    return this.failed;
  }
}

/**
 * 文档类型 → 渲染器 的登记表。
 *
 * 这里是「用什么渲染」这个问题的**唯一答案**。App 不直接认识任何渲染器，
 * 只把当前文档的类型交给 `ViewerSurface`，由它来查表 —— 于是 P3-06/07/08
 * 各自只需要新增一个文件 + 一次 `registerLazy`，App.tsx 一行都不用改。
 */
export class ViewerRendererRegistry {
  private readonly renderers = new Map<ViewerDocumentType, LazyViewerRenderer>();

  /**
   * 登记一个渲染器。
   *
   * 同一类型重复登记直接抛错：静默覆盖会让「哪个实现生效」取决于注册顺序，
   * 而症状是「换了实现但行为没变」这类几乎查不出来的问题。
   */
  registerLazy(registration: ViewerRendererRegistration): void {
    if (this.renderers.has(registration.type)) {
      throw new Error(`viewer renderer for "${registration.type}" is already registered`);
    }
    this.renderers.set(
      registration.type,
      new LazyViewerRenderer(registration.type, registration.load)
    );
  }

  /**
   * 取某类型的渲染器；没有登记则返回 `undefined`（外壳据此回落占位页）。
   *
   * 刻意不做成响应式的：登记全部发生在启动阶段，之后不再变化 ——
   * 做成可订阅反而会让人以为「运行期还能换渲染器」，而那意味着组件身份不稳定。
   */
  get(type: ViewerDocumentType): LazyViewerRenderer | undefined {
    return this.renderers.get(type);
  }

  /** 已登记的渲染器类型，按登记顺序。 */
  registeredTypes(): ViewerDocumentType[] {
    return [...this.renderers.keys()];
  }

  /**
   * 已经**开始** import 的渲染器类型。
   *
   * 这是「按需加载」最直接的判据：动态 `import()` 只有 `LazyViewerRenderer`
   * 里那一条路径，所以这个列表为空 ⟺ 这些渲染器的 chunk 一个字节都没下载。
   * 与 `ExtensionHost.requestedIds()` 同名同义，测试里两条判据写法一致。
   */
  requestedIds(): ViewerDocumentType[] {
    return [...this.renderers.values()]
      .filter((renderer) => renderer.requested)
      .map((renderer) => renderer.type);
  }

  /** 已经 import 回来（或已失败）的渲染器类型。 */
  loadedIds(): ViewerDocumentType[] {
    return [...this.renderers.values()]
      .filter((renderer) => renderer.loaded)
      .map((renderer) => renderer.type);
  }
}
