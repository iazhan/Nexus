import { EditorView, WidgetType } from '@codemirror/view';
import { translate } from '@nexus/i18n';
import {
  extensionHostFacet,
  mountExtension,
  type EditorExtensionControl
} from '../extensions.js';
import { editorLocaleFacet } from '../source-editor.js';
import { activateMathSource } from './math-activation.js';

export class LinkWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly label: string,
    public readonly safeHref: string | null,
    public readonly isBlocked: boolean = false,
    public readonly title?: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const a = document.createElement('a');
    a.className = 'cm-visual-link cm-visual-link-widget';
    a.dataset.from = String(this.from);
    a.dataset.to = String(this.to);
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '-1');

    if (this.isBlocked || !this.safeHref) {
      a.classList.add('cm-visual-link-blocked');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('title', this.title || 'Blocked unsafe link');
    } else {
      a.setAttribute('href', this.safeHref);
      if (this.title) {
        a.setAttribute('title', this.title);
      }
    }
    a.textContent = this.label || this.safeHref || this.raw;

    a.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return a;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof LinkWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.label === this.label &&
      other.safeHref === this.safeHref &&
      other.isBlocked === this.isBlocked &&
      other.title === this.title
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 图片 widget 的入参。
 *
 * 用对象而不是位置参数：字段已经到十个，其中两个是布尔、两个是可空字符串，
 * 位置一旦排错（`isBlocked` 与 `isEmbed` 互换）不会有任何报错，只会静默渲染错。
 */
export interface ImageWidgetOptions {
  /** 用来定位源文本的区间。**嵌入时是 `[[` 的下标**，不含 `!` —— 见 `isEmbed`。 */
  readonly from: number;
  readonly to: number;
  readonly raw: string;
  readonly alt: string;
  /** 经协议白名单净化的 `src`；被拦截时为 `null`。 */
  readonly safeSrc: string | null;
  readonly isBlocked?: boolean;
  readonly title?: string;
  /**
   * 实际写进 `<img src>` 的值。
   *
   * `undefined`（不传）与 `null` 都会走占位符，差别只在调用方语义：
   * `undefined` = 「没有可显示的地址」，`null` = 「解析过了，没解析出来」。
   */
  readonly displaySrc?: string | null;
  /** Obsidian 嵌入 `![[…|200]]` 的像素宽；`null` 表示不限宽，交给 CSS 夹。 */
  readonly width?: number | null;
  /** 来自 `![[…]]` 而非 `![](…)`：点击要开 wikilink 浮层，不是 image 浮层。 */
  readonly isEmbed?: boolean;
  /**
   * 嵌入的目标名，落到 `data-wikilink-target` 上供 Ctrl+点击导航。
   *
   * 嵌入曾经就是一个 `.cm-visual-wikilink`，导航靠它工作；改成图片之后如果不补回这个
   * 属性，Ctrl+点击会静默失效 —— 导航只认选择器命中的元素，命不中就什么都不发生。
   */
  readonly wikilinkTarget?: string;
  /**
   * 与源码并存的形态：光标落进引用范围内部时，图片**不消失**，而是插在源码之前
   * 占一行，源码留在下面就地可改。
   *
   * 这一态不承载点击：它只是源码旁边的一块预览，点它会再触发一次激活手势
   * （重开面板、丢掉正在输入的过滤词），所以 `toDOM` 不给它 `data-from/to`，
   * 点击处理里 `Number(undefined)` 是 `NaN`，直接放行。
   */
  readonly alongsideSource?: boolean;
}

export class ImageWidget extends WidgetType {
  public readonly from: number;
  public readonly to: number;
  public readonly raw: string;
  public readonly alt: string;
  public readonly safeSrc: string | null;
  public readonly isBlocked: boolean;
  public readonly title?: string;
  public readonly displaySrc?: string | null;
  public readonly width: number | null;
  public readonly isEmbed: boolean;
  public readonly wikilinkTarget?: string;
  public readonly alongsideSource: boolean;

  public constructor(options: ImageWidgetOptions) {
    super();
    this.from = options.from;
    this.to = options.to;
    this.raw = options.raw;
    this.alt = options.alt;
    this.safeSrc = options.safeSrc;
    this.isBlocked = options.isBlocked ?? false;
    this.title = options.title;
    this.displaySrc = options.displaySrc;
    this.width = options.width ?? null;
    this.isEmbed = options.isEmbed ?? false;
    this.wikilinkTarget = options.wikilinkTarget;
    this.alongsideSource = options.alongsideSource ?? false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-image cm-visual-image-widget';
    if (this.isEmbed) {
      span.classList.add('cm-visual-image-embed');
    }
    if (this.alongsideSource) {
      span.classList.add('cm-visual-image-alongside');
    }
    if (this.wikilinkTarget !== undefined) {
      span.dataset.wikilinkTarget = this.wikilinkTarget;
    }
    // 嵌入的装饰区间从 `!` 开始，但这里给的是 wikilink 节点自身的区间 ——
    // 点击浮层按**节点**区间精确匹配（`findInlineNodeAtRange`），
    // 多一个 `!` 就查不到节点，浮层静默不开。
    // 并存态不给区间：它不接点击（理由见 `alongsideSource`）。
    if (!this.alongsideSource) {
      span.dataset.from = String(this.from);
      span.dataset.to = String(this.to);
    }
    span.setAttribute('role', 'img');
    span.setAttribute('tabindex', '-1');

    const effectiveSrc = this.displaySrc !== undefined ? this.displaySrc : this.safeSrc;

    if (this.isBlocked || !effectiveSrc) {
      span.classList.add('cm-visual-image-blocked');
      span.setAttribute('aria-label', this.alt || (this.isBlocked ? 'Blocked unsafe image' : 'Unresolved image'));
      const placeholder = document.createElement('span');
      placeholder.className = 'cm-visual-image-placeholder';
      placeholder.textContent = this.isBlocked
        ? `[Blocked Image: ${this.alt || 'unsafe'}]`
        : `[Image: ${this.alt || 'unresolved'}]`;
      span.appendChild(placeholder);
      // 地址写错 / 图不在时补一句原因，否则占位符看着像渲染坏了。
      // 被协议拦下的不补：那是安全策略，`[Blocked …]` 已经说清楚了。
      if (!this.isBlocked) {
        const hint = document.createElement('span');
        hint.className = 'cm-visual-image-hint';
        hint.textContent = translate(view.state.facet(editorLocaleFacet), 'editor.imageUnresolved');
        span.appendChild(hint);
      }
    } else {
      const img = document.createElement('img');
      img.src = effectiveSrc;
      img.alt = this.alt;
      if (this.width !== null && this.width > 0) {
        // 只设宽、不设高：让高度按原始比例走。`max-width: 100%` 仍会兜住超宽。
        img.style.width = `${this.width}px`;
      }
      if (this.title) {
        img.title = this.title;
      }
      span.appendChild(img);
    }

    span.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return span;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.alt === this.alt &&
      other.safeSrc === this.safeSrc &&
      other.isBlocked === this.isBlocked &&
      other.title === this.title &&
      other.displaySrc === this.displaySrc &&
      other.width === this.width &&
      other.isEmbed === this.isEmbed &&
      other.wikilinkTarget === this.wikilinkTarget &&
      other.alongsideSource === this.alongsideSource
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class InlineMathWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string
  ) {
    super();
  }

  private control?: EditorExtensionControl;

  public toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-inline-math cm-visual-inline-math-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
    // 渲染体本身就是一个可激活的编辑入口：点击/回车把光标送进 range 内部，
    // 下一次投影重建时这个 widget 消失、`$...$` 变回可编辑的真实文本。
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute(
      'aria-label',
      translate(view.state.facet(editorLocaleFacet), 'editor.editInlineMath')
    );

    const host = view.state.facet(extensionHostFacet);

    this.control = mountExtension(
      host,
      { type: 'inline-math', from: this.from, to: this.to, text: this.formula },
      span,
      this.formula,
      () => {
        span.innerHTML = '';
        span.textContent = this.formula ? `$${this.formula}$` : '$$';
      },
      undefined,
      view.state.facet(editorLocaleFacet)
    );
    (span as any).__nexusExtensionControl = this.control;

    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      activateMathSource(view, this.from, this.to, this.raw);
    };
    // 用 mousedown 而不是 click：CM 的落光标逻辑也走 mousedown，
    // 晚一步处理就会先把光标贴到 widget 边界。
    span.addEventListener('mousedown', activate);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });

    return span;
  }

  public updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      return true;
    }
    return false;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof InlineMathWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class InlineCodeWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly value: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const code = document.createElement('code');
    code.className = 'cm-visual-inline-code cm-visual-inline-code-widget';
    code.dataset.from = String(this.from);
    code.dataset.to = String(this.to);
    code.setAttribute('role', 'textbox');
    code.setAttribute('tabindex', '-1');
    code.textContent = this.value;

    code.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return code;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof InlineCodeWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.value === this.value
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class WikiLinkWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly target: string,
    public readonly alias?: string
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-wikilink cm-visual-wikilink-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
    // 目标名要落到 dataset 上：宿主（App）拿它去**索引**里解析，
    // 编辑器自己不认识索引，也不该认识 —— 与 link-navigation 的分层一致。
    span.dataset.wikilinkTarget = this.target;
    span.setAttribute('role', 'link');
    span.setAttribute('tabindex', '-1');
    if (this.alias) {
      span.textContent = this.alias;
      span.title = this.target;
      span.setAttribute('aria-label', `${this.alias} (${this.target})`);
    } else {
      span.textContent = this.target;
      span.title = this.target;
      span.setAttribute('aria-label', this.target);
    }

    span.addEventListener('click', (e) => {
      e.preventDefault();
    });

    return span;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof WikiLinkWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.target === this.target &&
      other.alias === this.alias
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

