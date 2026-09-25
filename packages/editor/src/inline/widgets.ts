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

export class ImageWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly alt: string,
    public readonly safeSrc: string | null,
    public readonly isBlocked: boolean = false,
    public readonly title?: string,
    public readonly displaySrc?: string | null
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-visual-image cm-visual-image-widget';
    span.dataset.from = String(this.from);
    span.dataset.to = String(this.to);
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
    } else {
      const img = document.createElement('img');
      img.src = effectiveSrc;
      img.alt = this.alt;
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
      other.displaySrc === this.displaySrc
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

