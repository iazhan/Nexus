import type { MarkdownMarker } from './types.js';
import { translate } from '@nexus/i18n';

export interface EditorExtensionControl {
  /** Update the extension with new source text */
  update(source: string): void;
  /** Destroy the extension and clean up resources */
  destroy(): void;
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

  public constructor(private readonly loader: ExtensionLoader) {
    this.id = loader.id;
  }

  public canHandle(marker: MarkdownMarker): boolean {
    return this.loader.matches(marker);
  }

  public load(): Promise<void> {
    this.wasRequested = true;
    if (!this.pending) {
      this.pending = this.loader
        .load()
        .then(async (extension) => {
          await extension.load();
          this.inner = extension;
        })
        // 失败要允许重试：清掉 pending，下一次 load() 会重新 import。
        // 不这么做的话，首次失败会被永久缓存，错误 UI 上的「重试」按钮点了没用。
        .catch((err) => {
          this.pending = null;
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
}

export class ExtensionHost {
  private extensions: EditorExtension[] = [];
  private readonly lazy: LazyExtension[] = [];

  register(extension: EditorExtension) {
    this.extensions.push(extension);
  }

  /** 登记一个按需加载的扩展。谓词立刻生效，扩展包本体等第一次命中才 import。 */
  registerLazy(loader: ExtensionLoader): void {
    const extension = new LazyExtension(loader);
    this.lazy.push(extension);
    this.extensions.push(extension);
  }

  getHandler(marker: MarkdownMarker): EditorExtension | undefined {
    return this.extensions.find(ext => ext.canHandle(marker));
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
