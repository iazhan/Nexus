import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { parseMarkdown, sanitizeUrl, type MarkdownInlineNode } from '@nexus/markdown';
import { translate } from '@nexus/i18n';
import { editorLocaleFacet } from '../source-editor.js';
import type { MarkdownDocumentSession } from '../document-session.js';
import type { MarkdownEditTransaction } from '../types.js';
import {
  inlineEditOptionsFacet,
  type ActivePopoverState,
  type InlineCodeEditValue,
  type InlineEditContext,
  type InlineEditExtensionOptions,
  type InlineEditNodeType,
  type LinkEditValue,
  type WikiLinkEditValue,
  type WorkspaceImageOption
} from './types.js';
import { getInlineNodePlainText } from './text-utils.js';
import { findInlineNodeAtRange } from './node-lookup.js';
import { getReferenceKind } from './link-syntax.js';
import { activateImageSource } from './image-activation.js';
import {
  filterImageOptions,
  isCurrentImageOption,
  type ImageAddressStyle
} from './image-filter.js';
import {
  createInlineCodeEditTransaction,
  createImageEditTransaction,
  createLinkEditTransaction,
  createWikiLinkEditTransaction
} from './transactions.js';

export function createInlineEditExtension(
  session: MarkdownDocumentSession,
  options: InlineEditExtensionOptions = {}
): Extension {
  let activePopover: ActivePopoverState | null = null;

  function closeActivePopover(): void {
    if (!activePopover) return;
    const { cleanupListeners, popoverEl, targetEl, view } = activePopover;
    cleanupListeners();
    if (popoverEl.parentNode) {
      popoverEl.parentNode.removeChild(popoverEl);
    }
    activePopover = null;
    // Restore focus
    if (targetEl && targetEl.isConnected) {
      targetEl.focus?.();
    } else if (view && view.contentDOM) {
      view.contentDOM.focus();
    }
  }

  const plugin = ViewPlugin.fromClass(
    class {
      public constructor(private readonly view: EditorView) {
        this.handleClick = this.handleClick.bind(this);
        this.view.dom.addEventListener('click', this.handleClick);
      }

      private handleClick(event: MouseEvent): void {
        if (this.view.state.readOnly) {
          return;
        }

        const target = event.target as HTMLElement | null;
        if (!target) return;

        // 行内代码、普通链接与行内公式都已改为就地可编辑：正文是真实文档文本，
        // 只由 cm-visual-inline-code / cm-visual-link / cm-visual-inline-math-source
        // mark 装饰承载，没有 data-from/to。它们必须留在选择器之外，否则会被这里的
        // preventDefault 吞掉点击、导致光标无法落入。表单元格内的行内代码同理。
        // 只有 raw 结构畸形时降级出的 InlineCodeWidget / LinkWidget 仍走 popover，
        // 故按 widget 专属类名匹配。
        const widgetEl = target.closest(
          '.cm-visual-image, .cm-visual-wikilink, .cm-visual-inline-code-widget, .cm-visual-link-widget'
        ) as HTMLElement | null;
        if (!widgetEl) return;

        // 守卫先于 preventDefault：命中没有 source range 的元素时直接放行，
        // 把事件交回浏览器，让光标正常落到真实文本上。
        const from = Number(widgetEl.dataset.from);
        const to = Number(widgetEl.dataset.to);
        if (isNaN(from) || isNaN(to)) return;

        event.preventDefault();
        event.stopPropagation();

        const currentSource = session.getSnapshot().source;
        const raw = currentSource.slice(from, to);
        const { root } = parseMarkdown(currentSource);

        // 图片走**就地揭示**，不是浮层：把光标送进范围内部，下一次投影重建时
        // `![](…)` / `![[…]]` 变回真实文本，地址就地可改 —— 与行内公式同一套交互。
        // 顺带浮出工作区图片列表，那是「选一张」的入口；地址仍可直接手打。
        if (widgetEl.classList.contains('cm-visual-image')) {
          // `![[x.png]]` 的 AST 节点是 wikilink，只是被投影渲染成了图片；
          // 拾取时要按 wikilink 回写，否则会把 `![[…]]` 改写成 `![](…)`。
          const isEmbed = widgetEl.classList.contains('cm-visual-image-embed');
          activateImageSource(this.view, from, to, raw);
          this.openImagePicker(widgetEl, {
            nodeType: isEmbed ? 'wikilink' : 'image',
            range: { from, to },
            raw,
            source: currentSource
          });
          return;
        }

        let nodeType: InlineEditNodeType | null = null;
        if (widgetEl.classList.contains('cm-visual-link')) nodeType = 'link';
        else if (widgetEl.classList.contains('cm-visual-inline-code')) nodeType = 'inline-code';
        else if (widgetEl.classList.contains('cm-visual-wikilink')) nodeType = 'wikilink';

        if (!nodeType) return;

        const targetNode = findInlineNodeAtRange(root, nodeType, { from, to });
        if (!targetNode) return;

        const context: InlineEditContext = {
          nodeType,
          range: { from, to },
          raw,
          source: currentSource
        };

        this.openPopover(widgetEl, context, targetNode);
      }

      private openPopover(
        widgetEl: HTMLElement,
        context: InlineEditContext,
        node: MarkdownInlineNode
      ): void {
        closeActivePopover();

        // 浮层文案全部走 i18n。语言由 `editorLocaleFacet` 注入（编辑器包不读 localStorage）；
        // 每次打开浮层时现取，所以切语言后新开的浮层立刻是新语言。
        const t = (key: string) => translate(this.view.state.facet(editorLocaleFacet), key);

        const initialRevision = session.getSnapshot().revision;
        const popover = document.createElement('div');
        popover.className = `cm-inline-edit-popover cm-${context.nodeType}-editor`;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'false');

        const errorEl = document.createElement('span');
        errorEl.className = 'cm-inline-edit-error';
        errorEl.setAttribute('role', 'alert');

        const actionsEl = document.createElement('div');
        actionsEl.className = 'cm-inline-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'cm-inline-edit-save';
        saveBtn.textContent = t('popover.save');

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cm-inline-edit-cancel';
        cancelBtn.textContent = t('popover.cancel');

        actionsEl.appendChild(saveBtn);
        actionsEl.appendChild(cancelBtn);

        let getValues: () => unknown = () => ({});
        let isUnchanged: () => boolean = () => false;
        let firstInput: HTMLElement | null = null;

        const refKind = getReferenceKind(context.raw);
        const isReference = refKind === 'full' || refKind === 'collapsed' || refKind === 'shortcut';
        const isIdentifierBound = refKind === 'collapsed' || refKind === 'shortcut';

        if (context.nodeType === 'link' && node.type === 'link') {
          const labelField = document.createElement('label');
          labelField.className = 'cm-inline-edit-field';
          const labelTitle = document.createElement('span');
          labelTitle.className = 'cm-inline-edit-label';
          labelTitle.textContent = t('popover.linkText');
          const labelInput = document.createElement('input');
          labelInput.type = 'text';
          labelInput.className = 'cm-link-label-input';
          labelInput.setAttribute('aria-label', t('popover.linkTextAria'));
          const plainLabel = getInlineNodePlainText(node);
          labelInput.value = plainLabel;
          labelField.appendChild(labelTitle);
          labelField.appendChild(labelInput);

          const destField = document.createElement('label');
          destField.className = 'cm-inline-edit-field';
          const destTitle = document.createElement('span');
          destTitle.className = 'cm-inline-edit-label';
          destTitle.textContent = t('popover.linkDestination');
          const destInput = document.createElement('input');
          destInput.type = 'text';
          destInput.className = 'cm-link-dest-input';
          destInput.setAttribute('aria-label', t('popover.linkUrlAria'));
          destInput.value = node.href;
          if (isReference) {
            destInput.disabled = true;
            destInput.readOnly = true;
            destInput.title = t('popover.linkRefDestinationHint');
            destInput.setAttribute('aria-label', t('popover.linkRefDestinationAria'));
          }
          destField.appendChild(destTitle);
          destField.appendChild(destInput);

          const titleField = document.createElement('label');
          titleField.className = 'cm-inline-edit-field';
          const titleLabel = document.createElement('span');
          titleLabel.className = 'cm-inline-edit-label';
          titleLabel.textContent = t('popover.titleOptional');
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'cm-link-title-input';
          titleInput.setAttribute('aria-label', t('popover.linkTitleAria'));
          titleInput.value = node.title || '';
          if (isReference) {
            titleInput.disabled = true;
            titleInput.readOnly = true;
            titleInput.title = t('popover.linkRefTitleHint');
            titleInput.setAttribute('aria-label', t('popover.linkRefTitleAria'));
          }
          if (isIdentifierBound) {
            labelInput.disabled = true;
            labelInput.readOnly = true;
            labelInput.title = t('popover.linkRefLabelHint');
            labelInput.setAttribute('aria-label', t('popover.linkRefLabelAria'));
            saveBtn.disabled = true;
          }
          titleField.appendChild(titleLabel);
          titleField.appendChild(titleInput);

          popover.appendChild(labelField);
          popover.appendChild(destField);
          popover.appendChild(titleField);

          firstInput = isReference ? labelInput : destInput;

          const initialVals = {
            label: labelInput.value,
            destination: destInput.value,
            title: titleInput.value
          };

          getValues = (): LinkEditValue => ({
            label: labelInput.value,
            destination: destInput.value,
            title: titleInput.value.trim() ? titleInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as LinkEditValue;
            return (
              vals.label === initialVals.label &&
              vals.destination === initialVals.destination &&
              (vals.title || '') === initialVals.title
            );
          };
        } else if (context.nodeType === 'inline-code' && node.type === 'inline-code') {
          const codeField = document.createElement('label');
          codeField.className = 'cm-inline-edit-field';
          const codeTitle = document.createElement('span');
          codeTitle.className = 'cm-inline-edit-label';
          codeTitle.textContent = t('popover.codeValue');
          const codeInput = document.createElement('input');
          codeInput.type = 'text';
          codeInput.className = 'cm-code-input';
          codeInput.setAttribute('aria-label', t('popover.codeValueAria'));
          codeInput.value = node.value;
          codeField.appendChild(codeTitle);
          codeField.appendChild(codeInput);

          popover.appendChild(codeField);
          firstInput = codeInput;

          const initialCode = codeInput.value;
          getValues = (): InlineCodeEditValue => ({
            value: codeInput.value
          });

          isUnchanged = () => {
            const vals = getValues() as InlineCodeEditValue;
            return vals.value === initialCode;
          };
        } else if (context.nodeType === 'wikilink' && node.type === 'wikilink') {
          const targetField = document.createElement('label');
          targetField.className = 'cm-inline-edit-field';
          const targetTitle = document.createElement('span');
          targetTitle.className = 'cm-inline-edit-label';
          targetTitle.textContent = t('popover.wikiTarget');
          const targetInput = document.createElement('input');
          targetInput.type = 'text';
          targetInput.className = 'cm-wikilink-target-input';
          targetInput.setAttribute('aria-label', t('popover.wikiTargetAria'));
          targetInput.value = node.target;
          targetField.appendChild(targetTitle);
          targetField.appendChild(targetInput);

          const aliasField = document.createElement('label');
          aliasField.className = 'cm-inline-edit-field';
          const aliasTitle = document.createElement('span');
          aliasTitle.className = 'cm-inline-edit-label';
          aliasTitle.textContent = t('popover.wikiAlias');
          const aliasInput = document.createElement('input');
          aliasInput.type = 'text';
          aliasInput.className = 'cm-wikilink-alias-input';
          aliasInput.setAttribute('aria-label', t('popover.wikiAliasAria'));
          aliasInput.value = node.alias || '';
          aliasField.appendChild(aliasTitle);
          aliasField.appendChild(aliasInput);

          popover.appendChild(targetField);
          popover.appendChild(aliasField);
          firstInput = targetInput;

          const initialTarget = targetInput.value;
          const initialAlias = aliasInput.value;
          getValues = (): WikiLinkEditValue => ({
            target: targetInput.value,
            alias: aliasInput.value.trim() ? aliasInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as WikiLinkEditValue;
            return vals.target === initialTarget && (vals.alias || '') === initialAlias;
          };
        }

        popover.appendChild(errorEl);
        popover.appendChild(actionsEl);

        const validate = (): { isValid: boolean; error?: string; isUnchanged: boolean } => {
          if (isUnchanged()) {
            return { isValid: true, isUnchanged: true };
          }
          const vals = getValues();
          if (context.nodeType === 'link') {
            const l = vals as LinkEditValue;
            if (/[\r\n]/.test(l.label) || /[\r\n]/.test(l.destination) || (l.title && /[\r\n]/.test(l.title))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in links.', isUnchanged: false };
            }
            const sRes = sanitizeUrl(l.destination);
            if (sRes.isBlocked) {
              return { isValid: false, error: sRes.reason ?? 'Blocked potentially unsafe link protocol', isUnchanged: false };
            }
          } else if (context.nodeType === 'inline-code') {
            const c = vals as InlineCodeEditValue;
            if (/[\r\n]/.test(c.value)) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in inline code.', isUnchanged: false };
            }
          } else if (context.nodeType === 'wikilink') {
            const w = vals as WikiLinkEditValue;
            if (!w.target.trim()) {
              return { isValid: false, error: 'WikiLink target cannot be empty.', isUnchanged: false };
            }
            if (/[\r\n]/.test(w.target) || (w.alias && /[\r\n]/.test(w.alias))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in WikiLinks.', isUnchanged: false };
            }
            if (/[[\]]/.test(w.target) || (w.alias && /[[\]]/.test(w.alias))) {
              return { isValid: false, error: 'Brackets [ or ] are not permitted in WikiLinks.', isUnchanged: false };
            }
          }
          return { isValid: true, isUnchanged: false };
        };

        const commit = () => {
          if (!activePopover || activePopover.committed) return;
          if (this.view.state.readOnly) {
            closeActivePopover();
            return;
          }

          if (session.getSnapshot().revision !== initialRevision) {
            closeActivePopover();
            return;
          }

          const validation = validate();
          if (!validation.isValid) {
            errorEl.textContent = validation.error ?? 'Validation failed';
            return;
          }
          if (validation.isUnchanged) {
            closeActivePopover();
            return;
          }

          const currentSource = session.getSnapshot().source;
          const vals = getValues();

          let tx: MarkdownEditTransaction | null = null;
          if (context.nodeType === 'link') {
            tx = createLinkEditTransaction(currentSource, context, vals as LinkEditValue);
          } else if (context.nodeType === 'inline-code') {
            tx = createInlineCodeEditTransaction(currentSource, context, vals as InlineCodeEditValue);
          } else if (context.nodeType === 'wikilink') {
            tx = createWikiLinkEditTransaction(currentSource, context, vals as WikiLinkEditValue);
          }

          if (tx) {
            activePopover.committed = true;
            session.dispatch(tx);
            closeActivePopover();
          } else {
            errorEl.textContent = t('popover.invalidSyntax');
          }
        };

        const handlePopoverKeydown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeActivePopover();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
        };

        const handleOutsidePointer = (e: MouseEvent | TouchEvent) => {
          const target = e.target as HTMLElement | null;
          if (!target) return;
          if (
            popover.contains(target) ||
            widgetEl.contains(target) ||
            target.closest('.cm-inline-edit-popover')
          ) {
            return;
          }
          closeActivePopover();
        };

        popover.addEventListener('keydown', handlePopoverKeydown);
        popover.addEventListener('pointerdown', (e) => e.stopPropagation());
        popover.addEventListener('click', (e) => e.stopPropagation());

        saveBtn.addEventListener('click', (e) => {
          e.preventDefault();
          commit();
        });

        cancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          closeActivePopover();
        });

        const doc = this.view.dom.ownerDocument ?? document;
        doc.addEventListener('pointerdown', handleOutsidePointer, true);

        const cleanupListeners = () => {
          doc.removeEventListener('pointerdown', handleOutsidePointer, true);
        };

        activePopover = {
          view: this.view,
          session,
          context,
          initialRevision,
          popoverEl: popover,
          targetEl: widgetEl,
          cleanupListeners,
          committed: false
        };

        // Compute floating position within view.dom
        const widgetRect = widgetEl.getBoundingClientRect?.() ?? { left: 0, bottom: 0, top: 0 };
        const viewRect = this.view.dom.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        const leftOffset = Math.max(0, widgetRect.left - viewRect.left);
        const topOffset = Math.max(0, widgetRect.bottom - viewRect.top + 4);
        popover.style.left = `${leftOffset}px`;
        popover.style.top = `${topOffset}px`;

        this.view.dom.appendChild(popover);
        firstInput?.focus();
      }

      /**
       * 浮出工作区图片列表 —— 「选一张」的入口。
       *
       * 与表单浮层（`openPopover`）共用同一套生命周期（定位、外部点击关闭、视图销毁），
       * 但**不在文档变化时关闭**：用户可能正在就地改地址，改完还要从列表里挑一张。
       * 指向的区间靠 `update()` 里的 `mapPos` 跟着事务走，所以输入之后坐标仍然是对的。
       *
       * 宿主没提供 `workspaceImages` 时**不浮列表** —— 一个空列表比没有更让人困惑。
       * 那种情况下图片照样就地揭示，地址直接手打；只有上传钩子时面板里只剩那一个按钮。
       */
      private openImagePicker(widgetEl: HTMLElement, context: InlineEditContext): void {
        const facetOptions = this.view.state.facet(inlineEditOptionsFacet) as
          | InlineEditExtensionOptions
          | undefined;
        const provider = options.workspaceImages ?? facetOptions?.workspaceImages;
        const resolver = options.imageSourceResolver ?? facetOptions?.imageSourceResolver;
        // 两个入口都没有就整个不浮：列不出图、也传不了图，面板里只剩一个标题。
        if (!provider && !resolver) return;

        closeActivePopover();

        const t = (key: string) => translate(this.view.state.facet(editorLocaleFacet), key);
        const initialRevision = session.getSnapshot().revision;

        const popover = document.createElement('div');
        popover.className = 'cm-inline-edit-popover cm-image-picker';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'false');

        const titleEl = document.createElement('span');
        titleEl.className = 'cm-inline-edit-label';
        titleEl.textContent = t('popover.imagePickTitle');

        const listEl = document.createElement('div');
        listEl.className = 'cm-image-picker-list';

        const errorEl = document.createElement('span');
        errorEl.className = 'cm-inline-edit-error';
        errorEl.setAttribute('role', 'alert');

        if (provider) popover.appendChild(titleEl);
        popover.appendChild(listEl);

        if (resolver) {
          const uploadBtn = document.createElement('button');
          uploadBtn.type = 'button';
          uploadBtn.className = 'cm-image-upload-btn';
          uploadBtn.textContent = t('popover.imageUpload');
          uploadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const target = this.currentPickerTarget();
            if (!target) {
              errorEl.textContent = t('popover.imagePickGone');
              return;
            }
            const capturedRevision = session.getSnapshot().revision;
            // 同步调用、显式接住同步抛：钩子是宿主代码，抛出来不该从点击处理器里
            // 冒到顶层（那样面板上什么都不显示，用户只看到"点了没反应"）。
            let pending: Promise<string | null> | string | null;
            try {
              pending = resolver(target.destination, {
                range: target.range,
                raw: target.raw,
                alt: target.alt,
                destination: target.destination,
                title: target.title
              });
            } catch (err) {
              errorEl.textContent = (err as Error).message || 'Resolver failed';
              return;
            }

            void Promise.resolve(pending)
              .then((resolved) => {
                if (!activePopover || activePopover.popoverEl !== popover) return;
                if (this.view.state.readOnly) return;
                if (session.getSnapshot().revision !== capturedRevision) return;
                if (typeof resolved === 'string' && resolved) {
                  // 上传只解析出一个地址，两种写法共用它。
                  this.applyPickedImage({ path: resolved, wikiPath: resolved }, errorEl);
                }
              })
              .catch((err: unknown) => {
                if (!activePopover || activePopover.popoverEl !== popover) return;
                errorEl.textContent = (err as Error).message || 'Resolver failed';
              });
          });
          popover.appendChild(uploadBtn);
        }

        popover.appendChild(errorEl);

        // 候选列表的内容跟着「当前输入的地址」走，不是「工作区里有什么」—— 用户改地址时
        // 列表收敛到匹配的图，所以它是自动补全而不是相册。全量只取一次：工作区没变，
        // 重取只会让异步回来时覆盖掉用户已经输入的内容。
        let allItems: readonly WorkspaceImageOption[] | null = null;

        /** 当前这条引用写着的地址，每次都从最新文档重算（见 `currentPickerTarget`）。 */
        const currentQuery = (): string => this.currentPickerTarget()?.destination ?? '';

        /**
         * 这次编辑写的是哪种地址。嵌入档的地址是 Obsidian 的最短唯一路径，与 `![](…)`
         * 的文档目录相对不同 —— 过滤与预选都得按同一种比，否则一条都命不中。
         */
        const currentStyle = (): ImageAddressStyle =>
          this.currentPickerTarget()?.isEmbed ? 'wiki' : 'document';

        const renderList = (query: string): void => {
          listEl.textContent = '';
          if (!allItems) return;
          const style = currentStyle();
          const matched = filterImageOptions(allItems, query, style);
          if (matched.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'cm-image-picker-empty';
            // 「工作区里本来就没有图」与「有图但都不匹配当前输入」是两件事，文案不同。
            empty.textContent =
              allItems.length === 0 ? t('popover.imagePickEmpty') : t('popover.imagePickNoMatch');
            listEl.appendChild(empty);
            return;
          }
          for (const item of matched) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cm-image-picker-item';
            button.dataset.path = item.path;
            button.dataset.wikiPath = item.wikiPath;
            // 当前引用写着的那张标出来 —— 它就是这次编辑的「预选」。
            if (isCurrentImageOption(item, query, style)) {
              button.dataset.current = 'true';
            }
            button.setAttribute('aria-label', item.name);
            const thumb = document.createElement('img');
            thumb.src = item.url;
            thumb.alt = '';
            thumb.loading = 'lazy';
            const label = document.createElement('span');
            label.className = 'cm-image-picker-name';
            label.textContent = item.name;
            button.appendChild(thumb);
            button.appendChild(label);
            button.addEventListener('click', (e) => {
              e.preventDefault();
              // 两份地址都递给写回，由它按被编辑的节点类型挑一份：`![](…)` 用文档目录
              // 相对，`![[…]]` 用 Obsidian 的最短唯一路径。回写走对应的事务，
              // `![[…]]` 的写法不会被改写成 `![](…)`。
              this.applyPickedImage(item, errorEl);
            });
            listEl.appendChild(button);
          }
        };

        popover.addEventListener('pointerdown', (e) => e.stopPropagation());
        popover.addEventListener('click', (e) => e.stopPropagation());
        popover.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          closeActivePopover();
        });

        const doc = this.view.dom.ownerDocument ?? document;
        const handleOutsidePointer = (e: MouseEvent | TouchEvent) => {
          const target = e.target as HTMLElement | null;
          if (!target) return;
          if (popover.contains(target) || target.closest('.cm-inline-edit-popover')) return;
          closeActivePopover();
        };
        doc.addEventListener('pointerdown', handleOutsidePointer, true);

        activePopover = {
          view: this.view,
          session,
          context,
          initialRevision,
          popoverEl: popover,
          targetEl: widgetEl,
          cleanupListeners: () => doc.removeEventListener('pointerdown', handleOutsidePointer, true),
          committed: false,
          pickerRange: { ...context.range },
          refreshList: () => renderList(currentQuery())
        };

        // 定位用**揭示之后**的文本坐标：widget 在 `activateImageSource` 那一步已经从 DOM
        // 里消失了，拿它自己的 rect 会得到 `0,0`。
        const viewRect = this.view.dom.getBoundingClientRect();
        const anchor = this.anchorRectAt(context.range.from, widgetEl);
        popover.style.left = `${Math.max(0, anchor.left - viewRect.left)}px`;
        popover.style.top = `${Math.max(0, anchor.bottom - viewRect.top + 4)}px`;
        this.view.dom.appendChild(popover);

        if (!provider) return;

        void Promise.resolve(provider())
          .then((items) => {
            if (!activePopover || activePopover.popoverEl !== popover) return;
            allItems = items;
            // 打开时按当前地址过滤：列表一上来就停在「这条引用现在指的是哪张」。
            renderList(currentQuery());
          })
          .catch(() => {
            if (!activePopover || activePopover.popoverEl !== popover) return;
            errorEl.textContent = t('popover.imagePickLoadFailed');
          });
      }

      /**
       * 浮层要挂在哪一行的下沿。
       *
       * 首选 `coordsAtPos`（揭示之后源文本的真实位置），量不到就退回元素自身的矩形 ——
       * 无头环境（happy-dom）里量文本坐标会失败，而**定位失败不该让一次点击抛异常**：
       * 面板照常打开，只是位置退回元素处。
       */
      private anchorRectAt(
        pos: number,
        fallback: HTMLElement
      ): { left: number; bottom: number } {
        try {
          const coords = this.view.coordsAtPos(pos);
          if (coords && Number.isFinite(coords.left) && Number.isFinite(coords.bottom)) {
            return coords;
          }
        } catch {
          // 交给下面的兜底
        }
        const rect = fallback.getBoundingClientRect();
        return { left: rect.left, bottom: rect.bottom };
      }

      /**
       * 面板当前指向的那条引用，**每次都从最新文档重算**。
       *
       * 不能缓存打开时那份 `context`：面板刻意不在文档变化时关闭，用户一边就地改地址
       * 一边挑图是正常操作，缓存的区间与 raw 一次输入之后就全错位了 ——
       * `createImageEditTransaction` 的 `source.slice(from, to) !== raw` 守卫会静默
       * 让每一次挑选都失败。
       *
       * 取的是 **view 的当前文档**而不是 session 快照：session 的同步监听排在
       * `ViewPlugin.update` 之后，文档刚变的那一刻它还停在**上一个事务**上 ——
       * 拿它配新算出的区间，节点必然查不到，列表会静默退回「列出全部」。
       */
      private currentPickerTarget(): {
        source: string;
        range: { from: number; to: number };
        raw: string;
        destination: string;
        alt: string;
        title?: string;
        isEmbed: boolean;
        alias?: string;
      } | null {
        const range = activePopover?.pickerRange;
        if (!range) return null;
        const source = this.view.state.doc.toString();
        if (range.from < 0 || range.to > source.length || range.from >= range.to) return null;

        const raw = source.slice(range.from, range.to);
        const { root } = parseMarkdown(source);

        const imageNode = findInlineNodeAtRange(root, 'image', range);
        if (imageNode && imageNode.type === 'image') {
          return {
            source,
            range,
            raw,
            destination: imageNode.src,
            alt: imageNode.alt,
            title: imageNode.title,
            isEmbed: false
          };
        }

        const wikiNode = findInlineNodeAtRange(root, 'wikilink', range);
        if (wikiNode && wikiNode.type === 'wikilink') {
          return {
            source,
            range,
            raw,
            destination: wikiNode.target,
            alt: wikiNode.target,
            isEmbed: true,
            alias: wikiNode.alias
          };
        }

        return null;
      }

      /**
       * 把选中的图片写回文档。引用式图片（地址定义在别处）会失败并给出提示。
       *
       * 收**整条选项**而不是一个字符串：两种写法要写两份不同的地址（`![](…)` 相对文档
       * 目录、`![[…]]` 是 Obsidian 的最短唯一路径），由被编辑的节点类型决定用哪份。
       * 上传按钮只解析出一个地址，那时两份同值。
       */
      private applyPickedImage(
        picked: { readonly path: string; readonly wikiPath: string },
        errorEl: HTMLElement
      ): void {
        if (!activePopover) return;
        const t = (key: string) => translate(this.view.state.facet(editorLocaleFacet), key);
        const target = this.currentPickerTarget();
        if (!target) {
          errorEl.textContent = t('popover.imagePickGone');
          return;
        }

        const context: InlineEditContext = {
          nodeType: target.isEmbed ? 'wikilink' : 'image',
          range: target.range,
          raw: target.raw,
          source: target.source
        };
        const address = target.isEmbed ? picked.wikiPath : picked.path;
        const tx = target.isEmbed
          ? createWikiLinkEditTransaction(target.source, context, {
              target: address,
              alias: target.alias
            })
          : createImageEditTransaction(target.source, context, {
              alt: target.alt,
              destination: address,
              title: target.title
            });

        if (!tx) {
          errorEl.textContent = t('popover.imagePickFailed');
          return;
        }

        activePopover.committed = true;
        session.dispatch(tx);
        closeActivePopover();
      }

      public update(update: ViewUpdate): void {
        if (!activePopover) return;
        if (update.state.readOnly) {
          closeActivePopover();
          return;
        }
        if (!update.docChanged) return;

        // 图片选择器面板留着（见 `openImagePicker`）：指向的区间跟着事务走，
        // 列表按新地址重算 —— 用户改地址时两边一起动。
        if (activePopover.pickerRange) {
          activePopover.pickerRange = {
            from: update.changes.mapPos(activePopover.pickerRange.from, 1),
            to: update.changes.mapPos(activePopover.pickerRange.to, -1)
          };
          activePopover.refreshList?.();
          return;
        }

        closeActivePopover();
      }

      public destroy(): void {
        if (activePopover && activePopover.view === this.view) {
          closeActivePopover();
        }
        this.view.dom.removeEventListener('click', this.handleClick);
      }
    }
  );

  return [inlineEditOptionsFacet.of(options), plugin];
}
