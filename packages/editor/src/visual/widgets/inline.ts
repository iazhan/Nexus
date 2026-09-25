import { EditorView, WidgetType } from '@codemirror/view';
import { parseMarkdown } from '@nexus/markdown';
import { walkBlockNodes } from '../../ast-walker.js';
import { createSubEditorController } from '../sub-editor.js';

export class DelimiterWidget extends WidgetType {
  public constructor(
    public readonly delimiter: string,
    public readonly revealed: boolean = false
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.revealed ? 'cm-visual-delimiter-revealed' : 'cm-visual-hidden-delimiter';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.delimiter = this.delimiter;
    if (this.revealed) {
      element.textContent = this.delimiter;
    }
    return element;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof DelimiterWidget &&
      other.delimiter === this.delimiter &&
      other.revealed === this.revealed
    );
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

export { DelimiterWidget as HiddenDelimiterWidget };

export class HorizontalRuleWidget extends WidgetType {
  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return 33;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof HorizontalRuleWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-visual-hr-container';
    container.tabIndex = 0;
    container.setAttribute('role', 'separator');

    const hr = document.createElement('hr');
    hr.className = 'cm-visual-horizontal-rule';
    container.appendChild(hr);

    const startEdit = () => {
      if (view.state.readOnly) return;
      if (container.querySelector('.cm-hr-editor')) return;

      const raw = this.raw;
      // 标记内部空格可编辑；外围缩进、行尾空白和换行属于原始布局，单独保留。
      const match = raw.match(/^([ \t]*(?:>[ \t]*)*)([^\r\n]*?)([ \t]*(?:\r?\n)*)$/);
      const prefix = match ? match[1]! : '';
      const marker = match ? match[2]! : raw.trim();
      const suffix = match ? match[3]! : '';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-hr-editor';
      input.value = marker;

      hr.style.display = 'none';
      container.appendChild(input);
      input.focus();
      input.select();

      const controller = createSubEditorController(view, () => {
        input.remove();
        hr.style.display = '';
        container.focus();
      });
      const { signal } = controller;

      let isComposing = false;
      input.addEventListener('compositionstart', () => { isComposing = true; }, { signal });
      input.addEventListener('compositionend', () => { isComposing = false; }, { signal });

      const commit = () => {
        if (!controller.isActive() || view.state.readOnly) {
          controller.close();
          return;
        }
        const newValue = input.value;
        if (newValue === marker) {
          controller.close();
          return;
        }
        const source = view.state.doc.toString();
        const parsed = parseMarkdown(source);
        let targetRange: { from: number; to: number } | null = null;
        walkBlockNodes(parsed.root.children, (child) => {
          if (child.type === 'horizontal-rule' && child.range.from === this.from) {
            targetRange = { from: child.range.from, to: child.range.to };
            return true;
          }
          return false;
        });
        const finalRange = targetRange as { from: number; to: number } | null;
        if (finalRange) {
          const newRaw = prefix + newValue + suffix;
          view.dispatch({
            changes: { from: finalRange.from, to: finalRange.to, insert: newRaw },
            userEvent: 'horizontal-rule.edit'
          });
        }
        controller.close();
      };

      input.addEventListener(
        'keydown',
        (e) => {
          if (!controller.isActive() || isComposing || e.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            controller.close();
          }
        },
        { signal }
      );

      input.addEventListener(
        'blur',
        () => {
          if (controller.isActive() && !isComposing) {
            commit();
          }
        },
        { signal }
      );
    };

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit();
    });

    container.addEventListener('keydown', (e) => {
      if (e.target !== container) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        startEdit();
      }
    });

    return container;
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

export class TaskCheckboxWidget extends WidgetType {
  public constructor(
    public readonly checked: boolean,
    public readonly from: number,
    public readonly to: number
  ) {
    super();
  }

  public toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-visual-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');

    if (view.state.readOnly) {
      input.disabled = true;
    }

    input.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('change', () => {
      if (view.state.readOnly) return;
      const current = view.state.doc.sliceString(this.from, this.to);
      const isCurrentlyChecked = current.toLowerCase().includes('x');
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: isCurrentlyChecked ? '[ ]' : '[x]'
        },
        userEvent: 'task.toggle'
      });
    });

    return input;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 列表标记的视觉替身。
 *
 * 无序列表的 `-`/`*`/`+` 与有序列表的 `1.` 都是 source 语法标记，未进入编辑态时
 * 被 `DelimiterWidget` 隐藏（`.cm-visual-hidden-delimiter { display: none }`）。
 * 但列表标记同时也是读者可见的结构信息，隐藏后必须画出替身，否则整行既没有
 * 圆点也没有编号：
 *
 * - 无序列表画 `•`；
 * - 有序列表画 source 里的编号本身。刻意不做自动重编号：本编辑器的第一原则是
 *   「所见即文件内容」，显示的编号必须能在 source 里找到对应。
 *
 * 光标进入该列表项后改由 `DelimiterWidget` 显示真实 marker，可直接编辑。
 */
export class ListMarkerWidget extends WidgetType {
  public constructor(
    public readonly marker: string,
    public readonly ordered: boolean
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.ordered
      ? 'cm-visual-list-marker cm-visual-list-marker-ordered'
      : 'cm-visual-list-marker';
    element.setAttribute('aria-hidden', 'true');
    element.dataset.marker = this.marker;
    element.textContent = this.ordered ? this.marker : '•';
    return element;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof ListMarkerWidget &&
      other.marker === this.marker &&
      other.ordered === this.ordered
    );
  }

  public ignoreEvent(): boolean {
    return true;
  }
}

