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
  type ImageEditValue,
  type InlineCodeEditValue,
  type InlineEditContext,
  type InlineEditExtensionOptions,
  type InlineEditNodeType,
  type LinkEditValue,
  type WikiLinkEditValue
} from './types.js';
import { getInlineNodePlainText } from './text-utils.js';
import { findInlineNodeAtRange } from './node-lookup.js';
import { getReferenceKind } from './link-syntax.js';
import {
  createImageEditTransaction,
  createInlineCodeEditTransaction,
  createLinkEditTransaction,
  createWikiLinkEditTransaction
} from './transactions.js';

export function createInlineEditExtension(
  session: MarkdownDocumentSession,
  options: InlineEditExtensionOptions = {}
): Extension {
  let activePopover: ActivePopoverState | null = null;
  let globalResolverToken = 0;

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

        let nodeType: InlineEditNodeType | null = null;
        if (widgetEl.classList.contains('cm-visual-link')) nodeType = 'link';
        else if (widgetEl.classList.contains('cm-visual-image')) nodeType = 'image';
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
        } else if (context.nodeType === 'image' && node.type === 'image') {
          const altField = document.createElement('label');
          altField.className = 'cm-inline-edit-field';
          const altTitle = document.createElement('span');
          altTitle.className = 'cm-inline-edit-label';
          altTitle.textContent = t('popover.imageAlt');
          const altInput = document.createElement('input');
          altInput.type = 'text';
          altInput.className = 'cm-image-alt-input';
          altInput.setAttribute('aria-label', t('popover.imageAltAria'));
          altInput.value = node.alt;
          altField.appendChild(altTitle);
          altField.appendChild(altInput);

          const srcField = document.createElement('label');
          srcField.className = 'cm-inline-edit-field';
          const srcTitle = document.createElement('span');
          srcTitle.className = 'cm-inline-edit-label';
          srcTitle.textContent = t('popover.imageSource');
          const srcInput = document.createElement('input');
          srcInput.type = 'text';
          srcInput.className = 'cm-image-src-input';
          srcInput.setAttribute('aria-label', t('popover.imageSourceAria'));
          srcInput.value = node.src;
          if (isReference) {
            srcInput.disabled = true;
            srcInput.readOnly = true;
            srcInput.title = t('popover.imageRefSourceHint');
            srcInput.setAttribute('aria-label', t('popover.imageRefSourceAria'));
          }
          srcField.appendChild(srcTitle);
          srcField.appendChild(srcInput);

          let srcInputVersion = 0;
          srcInput.addEventListener('input', () => {
            srcInputVersion++;
          });

          const titleField = document.createElement('label');
          titleField.className = 'cm-inline-edit-field';
          const titleLabel = document.createElement('span');
          titleLabel.className = 'cm-inline-edit-label';
          titleLabel.textContent = t('popover.titleOptional');
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'cm-image-title-input';
          titleInput.setAttribute('aria-label', t('popover.imageTitleAria'));
          titleInput.value = node.title || '';
          if (isReference) {
            titleInput.disabled = true;
            titleInput.readOnly = true;
            titleInput.title = t('popover.imageRefTitleHint');
            titleInput.setAttribute('aria-label', t('popover.imageRefTitleAria'));
          }
          if (isIdentifierBound) {
            altInput.disabled = true;
            altInput.readOnly = true;
            altInput.title = t('popover.imageRefAltHint');
            altInput.setAttribute('aria-label', t('popover.imageRefAltAria'));
            saveBtn.disabled = true;
          }
          titleField.appendChild(titleLabel);
          titleField.appendChild(titleInput);

          popover.appendChild(altField);
          popover.appendChild(srcField);
          popover.appendChild(titleField);

          const facetOptions = this.view.state.facet(inlineEditOptionsFacet) as InlineEditExtensionOptions | undefined;
          const resolver = !isReference ? (options.imageSourceResolver ?? facetOptions?.imageSourceResolver) : undefined;
          if (resolver) {
            const uploadBtn = document.createElement('button');
            uploadBtn.type = 'button';
            uploadBtn.className = 'cm-image-upload-btn';
            uploadBtn.textContent = t('popover.imageUpload');
            uploadBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              const requestToken = ++globalResolverToken;
              const capturedRevision = initialRevision;
              const capturedInputVersion = srcInputVersion;
              try {
                const resolved = await resolver(srcInput.value, {
                  range: context.range,
                  raw: context.raw,
                  alt: altInput.value,
                  destination: srcInput.value,
                  title: titleInput.value || undefined
                });
                if (
                  !activePopover ||
                  activePopover.popoverEl !== popover ||
                  requestToken !== globalResolverToken ||
                  session.getSnapshot().revision !== capturedRevision ||
                  this.view.state.readOnly ||
                  srcInputVersion !== capturedInputVersion
                ) {
                  return;
                }
                if (typeof resolved === 'string' && resolved) {
                  srcInput.value = resolved;
                  srcInputVersion++;
                }
              } catch (err) {
                if (
                  !activePopover ||
                  activePopover.popoverEl !== popover ||
                  requestToken !== globalResolverToken ||
                  session.getSnapshot().revision !== capturedRevision ||
                  this.view.state.readOnly ||
                  srcInputVersion !== capturedInputVersion
                ) {
                  return;
                }
                errorEl.textContent = (err as Error).message || 'Resolver failed';
              }
            });
            popover.appendChild(uploadBtn);
          }

          firstInput = isReference ? altInput : srcInput;

          const initialVals = {
            alt: altInput.value,
            destination: srcInput.value,
            title: titleInput.value
          };

          getValues = (): ImageEditValue => ({
            alt: altInput.value,
            destination: srcInput.value,
            title: titleInput.value.trim() ? titleInput.value : undefined
          });

          isUnchanged = () => {
            const vals = getValues() as ImageEditValue;
            return (
              vals.alt === initialVals.alt &&
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
          } else if (context.nodeType === 'image') {
            const img = vals as ImageEditValue;
            if (/[\r\n]/.test(img.alt) || /[\r\n]/.test(img.destination) || (img.title && /[\r\n]/.test(img.title))) {
              return { isValid: false, error: 'Newlines (CR/LF) are not permitted in images.', isUnchanged: false };
            }
            const sRes = sanitizeUrl(img.destination);
            if (sRes.isBlocked) {
              return { isValid: false, error: sRes.reason ?? 'Blocked potentially unsafe image protocol', isUnchanged: false };
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
          } else if (context.nodeType === 'image') {
            tx = createImageEditTransaction(currentSource, context, vals as ImageEditValue);
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

      public update(update: ViewUpdate): void {
        if (activePopover) {
          if (update.state.readOnly || update.docChanged) {
            closeActivePopover();
          }
        }
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
