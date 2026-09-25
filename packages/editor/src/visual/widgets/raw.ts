import { EditorView, WidgetType } from '@codemirror/view';
import { createSubEditorController, RAW_BLOCK_EDIT_USER_EVENT } from '../sub-editor.js';

export class RawBlockWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof RawBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-raw-block';
    container.textContent = this.raw;

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-raw-block-editor')) return;

      const trailing = this.raw.match(/(\r?\n)+$/);
      const trailingNl = trailing ? trailing[0]! : '';

      const textarea = document.createElement('textarea');
      textarea.className = 'cm-raw-block-editor';
      textarea.value = this.raw.slice(0, this.raw.length - trailingNl.length);

      container.textContent = '';
      container.appendChild(textarea);
      textarea.focus();

      const controller = createSubEditorController(view, () => {
        if (container.contains(textarea)) textarea.remove();
        container.textContent = this.raw;
      });
      const { signal } = controller;

      let isComposing = false;
      textarea.addEventListener(
        'compositionstart',
        () => {
          isComposing = true;
        },
        { signal }
      );
      textarea.addEventListener(
        'compositionend',
        () => {
          isComposing = false;
        },
        { signal }
      );

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newRaw = textarea.value + trailingNl;
        controller.close();
        view.dispatch({
          changes: [{ from: this.from, to: this.to, insert: newRaw }],
          userEvent: RAW_BLOCK_EDIT_USER_EVENT
        });
      };

      textarea.addEventListener(
        'keydown',
        (ke) => {
          if (!controller.isActive() || isComposing || ke.isComposing) return;
          if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
            ke.preventDefault();
            ke.stopPropagation();
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            ke.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      textarea.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) commit();
        },
        { signal }
      );
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

