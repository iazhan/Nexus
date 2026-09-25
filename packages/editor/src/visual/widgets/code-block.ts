import { EditorSelection } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { translate } from '@nexus/i18n';
import { extensionHostFacet, mountExtension } from '../../extensions.js';
import { dispatchCodeBlockLanguageChange } from '../../code-block-edit.js';
import { DEFAULT_CODE_LANGUAGES, normalizeLanguage } from '../../code-highlight.js';
import { editorLocaleFacet } from '../../source-editor.js';
import { mermaidPreviewSettingsFacet, setMermaidPreviewPinEffect } from '../state.js';

const COPY_ICON_SVG = `<svg class="cm-code-copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg class="cm-code-copy-icon cm-code-copy-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

function bindClipboardCopy(
  copyBtn: HTMLButtonElement,
  getText: () => string,
  setTimer: ((timer: ReturnType<typeof setTimeout> | null) => void) | undefined,
  t: (key: string) => string
): void {
  copyBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) {
      copyBtn.dataset.copyState = 'error';
      copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copyFailed')}</span>`;
      return;
    }
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        copyBtn.dataset.copyState = 'success';
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `${CHECK_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copied')}</span>`;
        const timer = setTimeout(() => {
          copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;
          copyBtn.classList.remove('copied');
          delete copyBtn.dataset.copyState;
          setTimer?.(null);
        }, 2000);
        setTimer?.(timer);
      })
      .catch(() => {
        copyBtn.dataset.copyState = 'error';
        copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">Failed</span>`;
      });
  });
}

export class CodeBlockHeaderWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly firstLineTo: number,
    public readonly language: string | undefined,
    public readonly value: string,
    public readonly blockTo: number,
    /** 按钮文案依赖语言：进 eq() 才能让运行时切语言时重建 DOM，而不是留着旧文案。 */
    public readonly locale: string
  ) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockHeaderWidget &&
      other.from === this.from &&
      other.firstLineTo === this.firstLineTo &&
      other.language === this.language &&
      other.value === this.value &&
      other.blockTo === this.blockTo &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const t = (key: string, variables?: Record<string, string>) =>
      translate(view.state.facet(editorLocaleFacet), key, variables);

    const container = document.createElement('div');
    container.className = 'cm-code-header-widget';

    const select = document.createElement('select');
    select.className = 'cm-code-language-select';
    select.disabled = view.state.readOnly;
    select.setAttribute('aria-label', 'Code block language');

    const languages = [...DEFAULT_CODE_LANGUAGES];
    const currentLang = this.language || '';
    // 用归一化后的语言键匹配预设项，`C++` / `C#` / `ts` 这类手写围栏信息
    // 应当选中已有预设，而不是追加一个重复的“自定义语言”选项。
    const currentKey = currentLang ? normalizeLanguage(currentLang) : '';
    const matchedPreset = currentKey
      ? languages.find((l) => l.value !== '' && normalizeLanguage(l.value) === currentKey)
      : undefined;
    if (currentLang && !matchedPreset) {
      languages.push({ label: currentLang, value: currentLang });
    }

    for (const lang of languages) {
      const opt = document.createElement('option');
      opt.value = lang.value;
      opt.textContent = lang.label;
      select.appendChild(opt);
    }

    // 所有 option 追加完成后再统一设置选中项：既不依赖 append 顺序，
    // 也避免 option.selected 在后续 append 时被实现重置。
    select.value = matchedPreset ? matchedPreset.value : currentLang;

    select.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    select.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dispatchCodeBlockLanguageChange(view, this.from, select.value.trim(), this.language);
    });

    const leftGroup = document.createElement('div');
    leftGroup.className = 'cm-code-header-left';
    leftGroup.appendChild(select);

    const lineCount = this.value ? this.value.split(/\r?\n/).length : 0;
    if (lineCount > 0) {
      const countBadge = document.createElement('span');
      countBadge.className = 'cm-code-line-count';
      countBadge.textContent = t('codeBlock.lineCount', { count: String(lineCount) });
      leftGroup.appendChild(countBadge);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.setAttribute('aria-label', t('codeBlock.copyAria'));
    copyBtn.title = t('codeBlock.copyAria');
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;

    const actions = document.createElement('div');
    actions.className = 'cm-code-header-actions';
    if (this.language === 'mermaid') {
      // 揭示态走的是普通代码块的逐行装饰，按钮得在这里再放一份，
      // 否则进了源码态就切不回预览（预览 widget 已经不在了）。
      actions.appendChild(createMermaidModeToggle(view, this.from, this.blockTo, true));
    }
    actions.appendChild(copyBtn);

    container.appendChild(leftGroup);
    container.appendChild(actions);

    bindClipboardCopy(
      copyBtn,
      () => this.value,
      (timer) => {
        if (this.copyTimer) clearTimeout(this.copyTimer);
        this.copyTimer = timer;
      },
      t
    );

    return container;
  }
}

export class CodeBlockExitWidget extends WidgetType {
  public constructor(public readonly to: number) {
    super();
  }

  public eq(other: WidgetType): boolean {
    return other instanceof CodeBlockExitWidget && other.to === this.to;
  }

  public ignoreEvent(): boolean {
    return true;
  }

  public toDOM(view: EditorView): HTMLElement {
    const exit = document.createElement('div');
    exit.className = 'cm-code-exit-widget';
    exit.setAttribute('aria-hidden', 'true');

    exit.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || view.state.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const doc = view.state.doc;
      const targetPos = Math.min(this.to, doc.length);

      if (targetPos >= doc.length) {
        // At EOF: insert newline and place cursor on the new line
        const newline = doc.toString().includes('\r\n') ? '\r\n' : '\n';
        view.dispatch({
          changes: { from: targetPos, insert: newline },
          selection: EditorSelection.cursor(targetPos + newline.length),
          scrollIntoView: true
        });
      } else {
        // Not at EOF: targetPos is after the closing fence newline
        const isAlreadyEmptyLine =
          doc.sliceString(targetPos, targetPos + 1) === '\n' ||
          doc.sliceString(targetPos, targetPos + 2) === '\r\n';

        if (isAlreadyEmptyLine) {
          view.dispatch({
            selection: EditorSelection.cursor(targetPos),
            scrollIntoView: true
          });
        } else {
          const newline = doc.toString().includes('\r\n') ? '\r\n' : '\n';
          view.dispatch({
            changes: { from: targetPos, insert: newline },
            selection: EditorSelection.cursor(targetPos),
            scrollIntoView: true
          });
        }
      }
      view.focus();
    });

    return exit;
  }
}

/**
 * Mermaid 块的显示模式切换按钮。
 *
 * 它**只写 pin**，不直接翻转 DOM —— 渲染层按 `isMermaidSourceMode()` 派生结果，
 * 所以按钮与"点图揭示"两条路径共用同一个状态，不会互相覆盖：按钮是**粘性**的
 * （显式表态后一直有效），点图是**瞬时**的（光标一离开就回预览）。
 *
 * 两处渲染各要一份：预览 widget 的 header（`.cm-code-header`）与揭示态普通代码块的
 * header（`.cm-code-header-widget`）—— 揭示态走的是围栏代码块那套逐行装饰。
 */
function createMermaidModeToggle(
  view: EditorView,
  from: number,
  to: number,
  isSourceMode: boolean
): HTMLButtonElement {
  const locale = view.state.facet(editorLocaleFacet);
  const t = (key: string, variables?: Record<string, string>) =>
    translate(locale, key, variables);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-mermaid-toggle';
  // 标签描述"下一个动作"，与当前显示态相反
  button.textContent = isSourceMode ? t('codeBlock.showPreview') : t('codeBlock.showSource');
  button.title = isSourceMode ? t('codeBlock.showPreviewAria') : t('codeBlock.showSourceAria');
  button.setAttribute('aria-label', button.title);
  // 别让 CM 把光标挪走（mousedown 会冒泡到 contentDOM）
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!isSourceMode) {
      view.dispatch({ effects: setMermaidPreviewPinEffect.of({ from, mode: 'source' }) });
      return;
    }

    const pinPreview = setMermaidPreviewPinEffect.of({ from, mode: 'preview' });
    const head = view.state.selection.main.head;
    if (head > from && head <= to) {
      // 光标还在块内时只写 pin 不够：派生式里的光标项会立刻把它拉回源码态，
      // 按钮看起来"点了没反应"。顺手把光标移出块外。
      view.dispatch({ selection: { anchor: from }, effects: pinPreview });
    } else {
      view.dispatch({ effects: pinPreview });
    }
  });
  return button;
}

export class CodeBlockWidget extends WidgetType {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    public readonly from: number,
    public readonly to: number,
    public readonly raw: string,
    public readonly language: string | undefined,
    public readonly value: string,
    /** 按钮文案依赖语言：进 eq() 才能让运行时切语言时重建 DOM，而不是留着旧文案。 */
    public readonly locale: string
  ) {
    super();
  }

  public get estimatedHeight(): number {
    return 140;
  }

  public eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.raw === this.raw &&
      other.language === this.language &&
      other.value === this.value &&
      other.locale === this.locale
    );
  }

  public toDOM(view: EditorView): HTMLElement {
    const t = (key: string, variables?: Record<string, string>) =>
      translate(view.state.facet(editorLocaleFacet), key, variables);

    const container = document.createElement('div');
    container.className = 'cm-visual-code-block';

    const header = document.createElement('div');
    header.className = 'cm-code-header';

    const langBadge = document.createElement('span');
    langBadge.className = 'cm-code-language';
    langBadge.textContent = this.language || 'text';
    header.appendChild(langBadge);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cm-code-copy-btn';
    copyBtn.setAttribute('aria-label', t('codeBlock.copyAria'));
    copyBtn.title = t('codeBlock.copyAria');
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span class="cm-code-copy-label">${t('codeBlock.copy')}</span>`;

    // 按钮是"进源码"的默认路径（`clickToReveal` 默认关）。
    const modeToggle = createMermaidModeToggle(view, this.from, this.to, false);
    const actions = document.createElement('div');
    actions.className = 'cm-code-header-actions';
    actions.appendChild(modeToggle);
    actions.appendChild(copyBtn);

    header.appendChild(actions);
    container.appendChild(header);

    bindClipboardCopy(
      copyBtn,
      () => this.value,
      (timer) => {
        if (this.copyTimer) clearTimeout(this.copyTimer);
        this.copyTimer = timer;
      },
      t
    );

    // 只有预览体，没有"源码态"——源码由**揭示**给出：点击预览把光标送进块内，
    // 下一次投影重建时整块替换消失，` ``` ` 围栏与正文变回真实文档文本，
    // 走普通代码块那套逐行装饰（可编辑、有高亮、自带 header 与复制按钮）。
    //
    // 早先的做法是在 widget 内部放一个 <pre> 和一个 Source/Preview 切换按钮：
    // 那个 <pre> 只是静态文本，真实文档被替换吞掉了，所以"Source 态"根本没法编辑。
    const previewEl = document.createElement('div');
    previewEl.className = 'cm-mermaid-preview';
    const host = view.state.facet(extensionHostFacet);
    mountExtension(
      host,
      { type: 'code-fence', from: this.from, to: this.to, text: this.value, language: this.language },
      previewEl,
      this.value,
      () => {
        previewEl.innerHTML = '';
        const previewPre = document.createElement('pre');
        previewPre.textContent = this.value;
        previewEl.appendChild(previewPre);
        view.requestMeasure();
      },
      () => {
        view.requestMeasure();
      },
      view.state.facet(editorLocaleFacet)
    );
    container.appendChild(previewEl);

    previewEl.addEventListener('mousedown', (event) => {
      // 设置关闭时（默认）点图不揭示：把事件交回 CM —— 被整块替换的范围承载不了光标，
      // CM 只能把它贴到 from / to 边界上，严格揭示判据不成立，所以块保持预览态。
      if (!view.state.facet(mermaidPreviewSettingsFacet).clickToReveal) return;
      event.preventDefault();
      event.stopPropagation();
      // 落点取代码正文起点（跳过开围栏与语言标记），光标直接落在可编辑的内容行上。
      const contentOffset = this.raw.indexOf(this.value);
      const anchor = this.from + (contentOffset > 0 ? contentOffset : 1);
      view.focus();
      view.dispatch({ selection: { anchor: Math.min(anchor, this.to) } });
    });

    return container;
  }

  public destroy(): void {
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }

  public ignoreEvent(): boolean {
    return false;
  }
}

