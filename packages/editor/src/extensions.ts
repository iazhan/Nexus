import type { MarkdownMarker } from './types.js';
import { ALL_CAPABILITIES_ENABLED, createChangeNotifier, type CapabilityEnabled } from '@nexus/core';
import { translate } from '@nexus/i18n';

export interface EditorExtensionControl {
  /** Update the extension with new source text */
  update(source: string): void;
  /** Destroy the extension and clean up resources */
  destroy(): void;
}

/**
 * 扩展的运行时状态，供插件面板显示。
 *
 * `idle` 与 `loading` 的区别是「按内容懒加载」的可见证据 ——
 * 文档里没出现过触发语法时，扩展包一个字节都没下载。
 */
export interface ExtensionStatus {
  id: string;
  /**
   * idle = 已注册但从未被触发；loading = 正在加载；loaded = 可用；failed = 加载失败；
   * disabled = 用户关掉了（永远不会加载）。
   *
   * `disabled` 不能并进 `idle`：两者都「没加载」，但 `idle` 的意思是「用到它就会加载」，
   * `disabled` 是「用到了也不会加载」。画成同一个词就是谎报现状。
   */
  state: 'idle' | 'loading' | 'loaded' | 'failed' | 'disabled';
}

export interface EditorExtension {
  id: string;
  canHandle(marker: MarkdownMarker): boolean;
  load(): Promise<void>;
  activate(marker: MarkdownMarker, container: HTMLElement, source: string): EditorExtensionControl;
}

/**
 * 懒加载登记项：**先登记「谁负责哪种 marker」，扩展包本体等真正命中才 import**。
 *
 * `matches` 必须是便宜的纯谓词，并且要能在扩展包被 import 之前求值 ——
 * 这正是它住在 `extension-triggers.ts` 而不是扩展包里的原因。
 */
export interface ExtensionLoader {
  id: string;
  matches(marker: MarkdownMarker): boolean;
  /** 首次命中时才调用；实现里做 `import('@nexus/math')` 之类的动态导入。 */
  load(): Promise<EditorExtension>;
}

/**
 * 懒加载扩展的占位句柄。
 *
 * 它**先注册、后加载**：`registerLazy` 时就把自己塞进 host，所以 `getHandler` 立刻命中，
 * widget 走正常的 `Loading… → activate` 流程；但真正 `import()` 那个重包要等到第一次
 * `load()`，也就是文档里第一次出现触发语法。
 *
 * 这比「投影跑一遍发现有公式，再去 import，回来重建投影」简单得多：DOM 更新在
 * `mountExtension` 内部原地完成，投影不需要第二遍，也不需要为「扩展刚到」加状态。
 */
class LazyExtension implements EditorExtension {
  public readonly id: string;
  private inner: EditorExtension | null = null;
  private pending: Promise<void> | null = null;
  /** 单独记，不能从 pending/inner 反推：失败后两者都会回到初始值。 */
  private wasRequested = false;
  /**
   * 上一次 `load()` 是否失败。
   *
   * 同样不能反推：失败后 `pending` 被清空（为了允许重试）、`inner` 仍是 null，
   * 与「还没触发过」长得一模一样。插件面板要区分这两种状态，就必须单独记这一位。
   */
  private failed = false;

  /**
   * `onTransition` 在**每一个状态位翻转之后**调用。
   *
   * 三个位各翻各的，所以通知点有三处；漏掉任何一处，订阅方就会永远停在上一个状态
   * （面板显示「加载中」不消失，正是这个形状）。通知本身要不要合并、要不要推迟，
   * 由 `ExtensionHost` 那侧决定 —— 这里只如实报告「翻了」。
   */
  public constructor(
    private readonly loader: ExtensionLoader,
    private readonly onTransition: () => void
  ) {
    this.id = loader.id;
  }

  public canHandle(marker: MarkdownMarker): boolean {
    return this.loader.matches(marker);
  }

  public load(): Promise<void> {
    // 只在**真的翻转**时报告：`load()` 会被多个 widget 各调一次，重复报告
    // 会让订阅方白重渲染（而状态一个字节都没变）。
    if (!this.wasRequested) {
      this.wasRequested = true;
      this.onTransition();
    }
    if (!this.pending) {
      this.pending = this.loader
        .load()
        .then(async (extension) => {
          await extension.load();
          this.inner = extension;
          // 重试成功要把失败标记清掉，否则面板会一直显示「加载失败」
          this.failed = false;
          this.onTransition();
        })
        // 失败要允许重试：清掉 pending，下一次 load() 会重新 import。
        // 不这么做的话，首次失败会被永久缓存，错误 UI 上的「重试」按钮点了没用。
        .catch((err) => {
          this.pending = null;
          this.failed = true;
          this.onTransition();
          throw err;
        });
    }
    return this.pending;
  }

  public activate(
    marker: MarkdownMarker,
    container: HTMLElement,
    source: string
  ): EditorExtensionControl {
    if (!this.inner) {
      throw new Error(`extension "${this.id}" was activated before its load() resolved`);
    }
    return this.inner.activate(marker, container, source);
  }

  /** 扩展包是否已经 import 回来并完成 `load()`。 */
  public get resolved(): boolean {
    return this.inner !== null;
  }

  /** `load()` 是否被调用过 —— 即扩展包是否**开始**被 import。 */
  public get requested(): boolean {
    return this.wasRequested;
  }

  /** 上一次加载是否失败。失败后 `pending` 会被清空以允许重试，所以状态要单独记。 */
  public get hasFailed(): boolean {
    return this.failed;
  }
}

export class ExtensionHost {
  private extensions: EditorExtension[] = [];
  private readonly lazy: LazyExtension[] = [];
  private readonly notifier = createChangeNotifier();

  /**
   * 谁被用户关掉了。**在每次查表时求值，不在装配时筛** —— 于是启停立即生效：
   * 不用重新注册（`registerLazy` 对重复 id 是抛错的）、不用重启、也不需要给宿主补一套撤销注册。
   *
   * 不传 ＝ 全启用，那正是加这个机制之前的行为，也是所有既有测试的默认。
   */
  public constructor(
    private readonly isEnabled: CapabilityEnabled = ALL_CAPABILITIES_ENABLED
  ) {}

  register(extension: EditorExtension) {
    this.extensions.push(extension);
  }

  /** 登记一个按需加载的扩展。谓词立刻生效，扩展包本体等第一次命中才 import。 */
  registerLazy(loader: ExtensionLoader): void {
    const extension = new LazyExtension(loader, () => this.notifier.notify());
    this.lazy.push(extension);
    this.extensions.push(extension);
  }

  /**
   * 这个 id 现在启用吗。**启停的判定只有这一处** —— 查表、状态投影都问它，
   * 所以「面板说已禁用、编辑器却照样渲染」这种两处不一致不可能发生。
   *
   * ## 为什么由扩展渲染的 widget 要把它的答案记进自己的身份
   *
   * 「宿主认不认领这个 marker」是**渲染结果的一部分**：认领 → 渲染体，不认领 → 源码文本。
   * 而投影重算造出的新 widget 字段往往与旧的完全一样，`WidgetType.eq` 就按那几个字段比 ——
   * 相等时 CodeMirror 会**直接复用旧 DOM**（`Reused.DOM`，连 `updateDOM` 都不调），
   * 于是「用户刚在设置里关掉这个扩展」在 DOM 层完全看不见。
   *
   * 所以 `InlineMathWidget` / `BlockMathWidget` / `BlockMathPreviewWidget` / `CodeBlockWidget`
   * 都把构造那一刻的答案存成 `handled`，并且：
   *
   * - 进 `eq()` —— 不然连 `updateDOM` 都不会被调到；
   * - `updateDOM()` 里 `!handled` 直接返回 `false` —— 不然它会接过旧 DOM 只换个 widget
   *   实例，画面还是上一版的渲染体。
   *
   * 两处少一处都只会静默退回「关了设置没反应」。重新打开走的是同一条路：`handled`
   * 从 `false` 变 `true`，`eq` 不等 → 重跑 `toDOM` → 渲染回来。
   */
  isCapabilityEnabled(id: string): boolean {
    return this.isEnabled(id);
  }

  /**
   * 订阅扩展状态跃迁。返回退订函数。
   *
   * 存在的理由：`listExtensions()` 是**拉**模型，而扩展包是在用户看不见的时候加载完的
   * （投影挂载那条路）。没有通知的话，插件面板只能靠借别人的刷新信号（文档版本号）
   * 碰运气 —— 加载完成到下一次编辑之间，面板会一直停在「加载中」。
   *
   * **通知是异步的（下一拍），同拍的多次跃迁合并成一次。** 理由见 `createChangeNotifier`：
   * `React.lazy` 的工厂在渲染过程中跑，同步通知会撞上「渲染期间更新」。
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
   * ## 为什么必须有这一条
   *
   * `listExtensions()` 报的状态里有一档是 `disabled`，而它是**现问谓词**的（见下面那段）——
   * 所以用户拨完开关，这个方法报的东西立刻就变了。但 `revision` 不会自己跳：它只在
   * **加载态**跃迁时由 `LazyExtension` 通知。少了这一条，「宿主报什么」与「订阅方看到的」
   * 就断了——插件面板会一直停在旧状态，症状是「设置里关了插件，左侧栏还是『未加载』」。
   *
   * ## 为什么由调用方喊，而不是宿主自己订阅设置
   *
   * 谓词是一个裸函数（`(id) => boolean`），它没有变更通知。宿主也不该认识设置系统 ——
   * 它连 `plugins.disabled` 这个键名都不该知道。谁把谓词装进来，谁负责在谓词的**输入**变了
   * 之后喊一声：那是 `App`（组合根）。
   *
   * 名字与 `visual/state.ts` 的 `notifyCapabilitiesChanged(view)` 同源：同一个概念的三处信号
   * （注册表订阅方 / 编辑器投影 / 附件外壳），`grep` 一个词能找全。
   */
  notifyCapabilitiesChanged(): void {
    this.notifier.notify();
  }

  /**
   * 认领这个 marker 的扩展；没有则 `undefined`（调用方回落源码文本）。
   *
   * **被禁用的扩展直接跳过，而不是提前返回 `undefined`** —— 两个扩展认领同一种 marker 时
   * （`registerLazy` 不禁止这件事），关掉前一个应该落到后一个上，而不是让这个 marker 没人管。
   */
  getHandler(marker: MarkdownMarker): EditorExtension | undefined {
    return this.extensions.find(
      ext => this.isEnabled(ext.id) && ext.canHandle(marker)
    );
  }

  /**
   * 已经**开始** import 的懒加载扩展 id。
   *
   * 这是「按内容加载」最直接的判据：`import()` 只有 `LazyExtension.load()` 一条路径，
   * 所以这个列表为空 ⟺ 扩展包的 chunk 一个字节都没下载。
   */
  requestedIds(): string[] {
    return this.lazy.filter(ext => ext.requested).map(ext => ext.id);
  }

  /** 已经 import 回来并 `load()` 完成的懒加载扩展 id。 */
  loadedIds(): string[] {
    return this.lazy.filter(ext => ext.resolved).map(ext => ext.id);
  }

  /**
   * 列出所有已注册扩展及其状态，供插件面板显示。
   *
   * 与 `requestedIds()` / `loadedIds()` 的区别：那两个只覆盖**懒加载**扩展、且只给 id。
   * 这里要连「注册了但文档里从没出现过触发语法」的也列出来 ——
   * 插件面板的意义正是让用户看见「装了哪些、哪些其实还没启用」。
   */
  listExtensions(): ExtensionStatus[] {
    return this.extensions.map((extension) => {
      // 关掉的排在最前：用户的选择解释了「为什么什么都没渲染」，比加载态更该被看见
      if (!this.isEnabled(extension.id)) {
        return { id: extension.id, state: 'disabled' as const };
      }
      // 静态注册的扩展在 host 里就是就绪的
      if (!(extension instanceof LazyExtension)) {
        return { id: extension.id, state: 'loaded' as const };
      }
      if (extension.resolved) return { id: extension.id, state: 'loaded' as const };
      if (extension.hasFailed) return { id: extension.id, state: 'failed' as const };
      if (extension.requested) return { id: extension.id, state: 'loading' as const };
      return { id: extension.id, state: 'idle' as const };
    });
  }
}

import { Facet } from '@codemirror/state';
export const extensionHostFacet = Facet.define<ExtensionHost, ExtensionHost | undefined>({
  combine: values => values[0]
});

export function mountExtension(
  host: ExtensionHost | undefined,
  marker: MarkdownMarker,
  container: HTMLElement,
  source: string,
  fallbackRender: () => void,
  onLoaded: (() => void) | undefined,
  /** 错误 UI 的文案语言。这里收字符串而不是 facet —— 本模块被 source-editor 依赖，
   *  反向 import 会成环。 */
  locale: string
): EditorExtensionControl | undefined {
  if (!host) {
    fallbackRender();
    return undefined;
  }
  const handler = host.getHandler(marker);
  if (!handler) {
    fallbackRender();
    return undefined;
  }

  container.innerHTML = '<span class="nexus-ext-loading">Loading...</span>';
  
  let control: EditorExtensionControl | undefined;
  let isActive = true;

  handler.load().then(() => {
    if (!isActive) return;
    container.innerHTML = '';
    try {
      control = handler.activate(marker, container, source);
      if (onLoaded) onLoaded();
    } catch (err) {
      console.error(`Extension activation failed for ${handler.id}:`, err);
      renderError();
    }
  }).catch(err => {
    console.error(`Extension loading failed for ${handler.id}:`, err);
    if (!isActive) return;
    renderError();
  });

  function renderError() {
    container.innerHTML = '';
    const errSpan = document.createElement('span');
    errSpan.className = 'nexus-ext-error';
    errSpan.textContent = `${translate(locale, 'extensions.unavailable', { id: handler!.id })} `;
    
    const retryBtn = document.createElement('button');
    retryBtn.className = 'nexus-ext-retry';
    retryBtn.textContent = translate(locale, 'editor.retry');
    retryBtn.onclick = (e) => {
      e.stopPropagation();
      mountExtension(host, marker, container, source, fallbackRender, undefined, locale);
    };
    errSpan.appendChild(retryBtn);
    container.appendChild(errSpan);
  }

  return {
    update(newSource: string) {
      if (control) control.update(newSource);
      source = newSource;
    },
    destroy() {
      isActive = false;
      if (control) control.destroy();
    }
  };
}
