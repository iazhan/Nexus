import type { MarkdownInlineNode } from '@nexus/markdown';

export const TABLE_ALIGN_LEFT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="15" y1="12" x2="3" y2="12"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>`;
export const TABLE_ALIGN_CENTER_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="19" y1="12" x2="5" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
export const TABLE_ALIGN_RIGHT_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="12" x2="9" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`;
export const TABLE_GRID_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`;
export const TABLE_TRASH_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

export function renderTableCellNodes(nodes: MarkdownInlineNode[], parentEl: HTMLElement): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        parentEl.appendChild(document.createTextNode(node.value));
        break;
      }
      case 'bold': {
        const strong = document.createElement('strong');
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '**';
        leftDelim.textContent = '**';
        strong.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, strong);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '**';
        rightDelim.textContent = '**';
        strong.appendChild(rightDelim);

        parentEl.appendChild(strong);
        break;
      }
      case 'italic': {
        const em = document.createElement('em');
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '*';
        leftDelim.textContent = '*';
        em.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, em);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '*';
        rightDelim.textContent = '*';
        em.appendChild(rightDelim);

        parentEl.appendChild(em);
        break;
      }
      case 'strike': {
        const del = document.createElement('del');
        del.className = 'cm-visual-strike';
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '~~';
        leftDelim.textContent = '~~';
        del.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, del);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '~~';
        rightDelim.textContent = '~~';
        del.appendChild(rightDelim);

        parentEl.appendChild(del);
        break;
      }
      case 'highlight': {
        const mark = document.createElement('mark');
        mark.className = 'cm-visual-highlight';
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '==';
        leftDelim.textContent = '==';
        mark.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, mark);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '==';
        rightDelim.textContent = '==';
        mark.appendChild(rightDelim);

        parentEl.appendChild(mark);
        break;
      }
      case 'inline-code': {
        const code = document.createElement('code');
        code.className = 'cm-visual-inline-code';
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '`';
        leftDelim.textContent = '`';
        code.appendChild(leftDelim);

        code.appendChild(document.createTextNode(node.value));

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '`';
        rightDelim.textContent = '`';
        code.appendChild(rightDelim);

        parentEl.appendChild(code);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.className = 'cm-visual-link';
        // Keep the original href/title for lossless serialization, but only ever
        // expose a sanitized href to the DOM. Mirrors the LinkWidget policy in
        // inline-edit.ts: blocked protocols must never become live anchors.
        a.dataset.rawHref = node.href ?? '';
        if (node.title) a.dataset.rawTitle = node.title;
        if (node.isBlocked || !node.safeHref) {
          a.classList.add('cm-visual-link-blocked');
          a.setAttribute('aria-disabled', 'true');
        } else {
          a.setAttribute('href', node.safeHref);
          if (node.title) a.setAttribute('title', node.title);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }

        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '[';
        leftDelim.textContent = '[';
        a.appendChild(leftDelim);

        if (node.children) {
          renderTableCellNodes(node.children, a);
        }

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = `](${node.href || ''})`;
        rightDelim.textContent = `](${node.href || ''})`;
        a.appendChild(rightDelim);

        parentEl.appendChild(a);
        break;
      }
      case 'inline-math': {
        const mathSpan = document.createElement('span');
        mathSpan.className = 'cm-table-inline-math';
        mathSpan.dataset.formula = node.formula;
        const leftDelim = document.createElement('span');
        leftDelim.className = 'cm-visual-hidden-delimiter';
        leftDelim.setAttribute('aria-hidden', 'true');
        leftDelim.dataset.delimiter = '$';
        leftDelim.textContent = '$';
        mathSpan.appendChild(leftDelim);

        const formulaText = document.createElement('span');
        formulaText.className = 'cm-table-math-render';
        formulaText.textContent = node.formula;
        mathSpan.appendChild(formulaText);

        const rightDelim = document.createElement('span');
        rightDelim.className = 'cm-visual-hidden-delimiter';
        rightDelim.setAttribute('aria-hidden', 'true');
        rightDelim.dataset.delimiter = '$';
        rightDelim.textContent = '$';
        mathSpan.appendChild(rightDelim);

        parentEl.appendChild(mathSpan);
        break;
      }
      case 'wikilink': {
        const wikiSpan = document.createElement('span');
        wikiSpan.className = 'cm-visual-wikilink';
        // Preserve target/alias so serialization can rebuild [[target|alias]].
        wikiSpan.dataset.wikiTarget = node.target;
        if (node.alias) wikiSpan.dataset.wikiAlias = node.alias;
        wikiSpan.textContent = node.alias || node.target;
        parentEl.appendChild(wikiSpan);
        break;
      }
      case 'raw': {
        if (/<br\s*\/?>/i.test(node.value)) {
          parentEl.appendChild(document.createElement('br'));
        } else {
          parentEl.appendChild(document.createTextNode(node.value));
        }
        break;
      }
      default: {
        if ('value' in node && typeof (node as any).value === 'string') {
          parentEl.appendChild(document.createTextNode((node as any).value));
        } else if ('raw' in node && typeof (node as any).raw === 'string') {
          parentEl.appendChild(document.createTextNode((node as any).raw));
        }
        break;
      }
    }
  }
}

export function serializeTableCellDOM(el: HTMLElement): string {
  let result = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const elem = child as HTMLElement;
      if (
        elem.classList.contains('cm-visual-hidden-delimiter') ||
        elem.classList.contains('cm-visual-delimiter-revealed') ||
        elem.getAttribute('aria-hidden') === 'true'
      ) {
        continue;
      }
      if (elem.classList.contains('cm-table-cell-placeholder')) {
        continue;
      }
      const tag = elem.tagName.toLowerCase();
      if (tag === 'br') {
        result += '<br>';
      } else if (tag === 'strong' || tag === 'b') {
        result += `**${serializeTableCellDOM(elem)}**`;
      } else if (tag === 'em' || tag === 'i') {
        result += `*${serializeTableCellDOM(elem)}*`;
      } else if (tag === 'del' || tag === 's' || elem.classList.contains('cm-visual-strike')) {
        result += `~~${serializeTableCellDOM(elem)}~~`;
      } else if (tag === 'mark' || elem.classList.contains('cm-visual-highlight')) {
        result += `==${serializeTableCellDOM(elem)}==`;
      } else if (tag === 'code' || elem.classList.contains('cm-visual-inline-code')) {
        result += `\`${serializeTableCellDOM(elem)}\``;
      } else if (tag === 'a' || elem.classList.contains('cm-visual-link')) {
        const href = elem.dataset.rawHref ?? elem.getAttribute('href') ?? '';
        const title = elem.dataset.rawTitle;
        result += `[${serializeTableCellDOM(elem)}](${href}${title ? ` "${title}"` : ''})`;
      } else if (elem.classList.contains('cm-table-inline-math') || elem.dataset.formula) {
        const formula = elem.dataset.formula ?? elem.textContent ?? '';
        result += `$${formula}$`;
      } else if (elem.classList.contains('cm-visual-wikilink')) {
        const target = elem.dataset.wikiTarget ?? '';
        const alias = elem.dataset.wikiAlias;
        result += alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
      } else {
        result += serializeTableCellDOM(elem);
      }
    }
  }
  return result;
}

export function populateTableCellDOM(cellEl: HTMLElement, cellNodes: MarkdownInlineNode[]): void {
  cellEl.textContent = '';
  const contentWrap = document.createElement('div');
  contentWrap.className = 'cm-table-cell-content';
  const cellRaw = cellNodes
    .map((n) => ('value' in n && typeof (n as any).value === 'string' ? (n as any).value : n.raw))
    .join('');
  if (!cellRaw.trim() && !cellNodes.some((n) => n.type === 'raw' && /<br\s*\/?>/i.test(n.value))) {
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-table-cell-placeholder';
    const br = document.createElement('br');
    placeholder.appendChild(br);
    contentWrap.appendChild(placeholder);
  } else {
    renderTableCellNodes(cellNodes, contentWrap);
  }
  cellEl.appendChild(contentWrap);
}

