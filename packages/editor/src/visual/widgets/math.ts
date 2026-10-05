import { EditorView, WidgetType } from '@codemirror/view';
import { translate } from '@nexus/i18n';
import {
  extensionHostFacet,
  mountExtension,
  type EditorExtensionControl,
  type ExtensionHost
} from '../../extensions.js';
import { activateMathSource } from '../../inline-edit.js';
import { editorLocaleFacet } from '../../source-editor.js';
import type { MarkdownMarker } from '../../types.js';

/**
 * 块级公式进入编辑态时追加在块尾的**实时预览**。
 *
 * 单独一个 WidgetType 子类而不是给 BlockMathWidget 加 `preview` 开关：
 * 两个变体的 className、可交互性和 `eq()` 语义都不同，用类区分更清楚，
 * 也避免"构造参数没送达"这类隐蔽问题。
 */
export class BlockMathPreviewWidget extends WidgetType {
  /** 建它时宿主还认领这个 marker 吗。必须进 `eq`、且让 `updateDOM` 返回 `false`，见 `ExtensionHost.isCapabilityEnabled`。 */
  public readonly handled: boolean;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string,
    host?: ExtensionHost
  ) {
    super();
    this.handled = host?.getHandler(this.marker()) !== undefined;
  }

  private control?: EditorExtensionControl;

  /** 构造、`toDOM`、`updateDOM` 共用的 marker —— 各写一遍会漂移。 */
  private marker(): MarkdownMarker {
    return { type: 'block-math', from: this.from, to: this.to, text: this.formula };
  }

  /** 追加的块级 widget：给一个下界，免得高度表在测量前把它算成 0 导致滚动跳动。 */
  public get estimatedHeight(): number {
    return 48;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof BlockMathPreviewWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula &&
      other.handled === this.handled
    );
  }

  public updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // 建它时就没有宿主认领 → DOM 里是 fallback 文本，没有可转发的渲染体。见 `handled`。
    if (!this.handled) return false;
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      view.requestMeasure();
      return true;
    }
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math cm-visual-block-math-preview';
    const host = view.state.facet(extensionHostFacet);
    this.control = mountExtension(
      host,
      this.marker(),
      container,
      this.formula,
      () => {
        container.innerHTML = '';
        container.textContent = `$$ ${this.formula} $$`;
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    (container as any).__nexusExtensionControl = this.control;
    return container;
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 块级公式 `$$...$$` 的投影。两个变体：
 *
 * - **渲染态**（`preview: false`）：整块替换成 KaTeX 结果；点击/回车把光标送进源码。
 * - **预览态**（`preview: true`）：只在光标进入块内时**追加在块尾**，与源码并存，
 *   边改边看。markra 的 `markra-math-render-active-preview` 就是这个思路。
 */
export class BlockMathWidget extends WidgetType {
  /** 建它时宿主还认领这个 marker 吗。必须进 `eq`、且让 `updateDOM` 返回 `false`，见 `ExtensionHost.isCapabilityEnabled`。 */
  public readonly handled: boolean;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly formula: string,
    host?: ExtensionHost
  ) {
    super();
    this.handled = host?.getHandler(this.marker()) !== undefined;
  }

  private control?: EditorExtensionControl;

  /** 构造、`toDOM`、`updateDOM` 共用的 marker —— 各写一遍会漂移。 */
  private marker(): MarkdownMarker {
    return { type: 'block-math', from: this.from, to: this.to, text: this.formula };
  }

  public get estimatedHeight(): number {
    return 60;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof BlockMathWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.formula === this.formula &&
      other.handled === this.handled
    );
  }

  public updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // 建它时就没有宿主认领 → DOM 里是 fallback 文本，没有可转发的渲染体。见 `handled`。
    if (!this.handled) return false;
    const control = (dom as any).__nexusExtensionControl as EditorExtensionControl | undefined;
    if (control) {
      control.update(this.formula);
      this.control = control;
      view.requestMeasure();
      return true;
    }
    return false;
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-block-math';
    const host = view.state.facet(extensionHostFacet);

    this.control = mountExtension(
      host,
      this.marker(),
      container,
      this.formula,
      () => {
        // 扩展不可用（懒加载失败 / 宿主没注册）：退化成源码文本，不能什么都不显示。
        container.innerHTML = '';
        container.textContent = `$$ ${this.formula} $$`;
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    (container as any).__nexusExtensionControl = this.control;

    {
      // 渲染态是整块替换，点击会被它吞掉（CM 只能把光标贴到边界），
      // 而揭示判据要求光标严格落在块内，所以激活手势必须自己接管。
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
      container.setAttribute(
        'aria-label',
        translate(view.state.facet(editorLocaleFacet), 'editor.editBlockMath')
      );
      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        activateMathSource(view, this.from, this.to, this.raw);
      };
      // 用 mousedown 而不是 click：CM 的落光标逻辑也走 mousedown，晚一步就先把光标贴到边界了。
      container.addEventListener('mousedown', activate);
      container.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
      });
    }

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

