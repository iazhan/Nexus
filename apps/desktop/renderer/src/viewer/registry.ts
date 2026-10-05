import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  ALL_CAPABILITIES_ENABLED,
  createChangeNotifier,
  type CapabilityEnabled,
  type ViewerDocumentType
} from '@nexus/core';
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
    load: () => Promise<ViewerRendererModule>,
    /**
     * 每个状态位翻转之后调用。
     *
     * 注意这条路径的**时机**：工厂由 `React.lazy` 在**渲染过程中**调用，所以第一次
     * `onTransition()` 就发生在渲染里 —— 通知的推迟与合并由 `ChangeNotifier` 负责，
     * 这里只如实报告「翻了」。漏报任何一处，订阅方就会永远停在「加载中」。
     */
    private readonly onTransition: () => void
  ) {
    this.lazyComponent = lazy(async () => {
      this.wasRequested = true;
      this.onTransition();
      try {
        const module = await load();
        this.resolved = true;
        this.onTransition();
        return module;
      } catch (error) {
        this.failed = true;
        this.onTransition();
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
  private readonly notifier = createChangeNotifier();

  /**
   * 谁被用户关掉了。**在每次查表时求值，不在装配时筛** —— 于是启停立即生效：
   * 不用重新登记（`registerLazy` 对重复类型是抛错的）、不用重启。
   *
   * 不传 ＝ 全启用，那正是加这个机制之前的行为，也是所有既有测试的默认。
   */
  public constructor(
    private readonly isEnabled: CapabilityEnabled = ALL_CAPABILITIES_ENABLED
  ) {}

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
      new LazyViewerRenderer(registration.type, registration.load, () => this.notifier.notify())
    );
  }

  /**
   * 订阅渲染器状态跃迁。返回退订函数。
   *
   * 与 `ExtensionHost.subscribe` 同形同义：状态是在用户看不见的时候变的（打开附件那条路），
   * 只靠 `get()` 拉的话，能力清单会停在「未加载」直到下一次别的原因触发重渲染。
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener);
  }

  /** 已经发出过多少次状态通知。`useSyncExternalStore` 的快照用它。 */
  get revision(): number {
    return this.notifier.revision;
  }

  /**
   * 谓词的答案可能变了（用户在设置里拨了内置能力的启停），叫醒订阅方。
   *
   * 与 `ExtensionHost.notifyCapabilitiesChanged()` 同形同义，理由见那里。这里只说一句本注册表
   * 特有的：`listRenderers()` 里那一格 `disabled` 也是**现问谓词**的，所以「拨开关 → 报的东西
   * 变了」在两张表上都成立，`revision` 也就都得跟着跳。
   *
   * 注意**别把它和 `ViewerSurface` 的信号搞混**：外壳走 `useSettingValue('plugins.disabled')`，
   * 自己就会重渲染；这一条是给「靠 `revision` 订阅」的消费者（插件面板）用的。
   */
  notifyCapabilitiesChanged(): void {
    this.notifier.notify();
  }

  /**
   * 这个类型现在启用吗。**启停的判定只有这一处** —— 查表、状态投影都问它，
   * 所以「清单说已禁用、附件却照样渲染」这种两处不一致不可能发生。
   *
   * 与 `get()` 返回 `undefined` 是两件事：那个回答「谁负责渲染」，这个回答「为什么没人渲染」——
   * 外壳要靠它区分「没登记渲染器」与「用户关掉了」（两张占位页的文案不同）。
   */
  isCapabilityEnabled(type: ViewerDocumentType): boolean {
    return this.isEnabled(type);
  }

  /**
   * 取某类型的渲染器；**没登记或已被禁用**则返回 `undefined`（外壳据此回落占位页）。
   *
   * 禁用的也返回 `undefined`，而不是「返回渲染器、由调用方自己判」：后者要求每个消费者
   * 都记得多问一句，忘掉的那一处会照常渲染被关掉的能力 —— 而症状是「设置里明明关了」。
   * 让「谁能渲染这份文档」只有这一个答案，消费者就不可能忘。
   *
   * **成员身份**不是响应式的：登记全部发生在启动阶段，之后不再增删，所以这个返回值
   * 在「没被禁用」时身份稳定 —— `ViewerSurface` 可以把它当组件类型直接用，不会因为
   * 一次重渲染而换掉实例。会变的是拿到的那个渲染器的**加载状态**，那一层走 `subscribe`。
   */
  get(type: ViewerDocumentType): LazyViewerRenderer | undefined {
    if (!this.isEnabled(type)) return undefined;
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

  /**
   * 列出全部已登记渲染器及其**原始状态位**，供能力清单显示。
   *
   * 与 `requestedIds()` / `loadedIds()` 的区别：那两个只覆盖「已经开始 / 已完成」的，
   * 这里要连「登记了但从没打开过该类型文档」的也列出来 —— 那正是用户最需要看见的一档。
   *
   * 刻意不在这里把四个 boolean 合成一个枚举：状态词表只该有一份，它住在能力清单那一侧
   * （`ExtensionStatus.state` 用的是同一套值）。两边各定一套「idle/loading/loaded/failed/disabled」，
   * 迟早出现「同一个渲染器在两处拼出不同状态」。
   */
  listRenderers(): ReadonlyArray<{
    type: ViewerDocumentType;
    requested: boolean;
    loaded: boolean;
    failed: boolean;
    disabled: boolean;
  }> {
    return [...this.renderers.values()].map((renderer) => ({
      type: renderer.type,
      requested: renderer.requested,
      loaded: renderer.loaded,
      failed: renderer.hasFailed,
      // 现问谓词，不缓存：缓存下来的话，改设置之后清单会一直显示旧状态，
      // 而「改了设置面板没反应」正是这次要避免的那一类问题。
      disabled: !this.isEnabled(renderer.type)
    }));
  }
}
