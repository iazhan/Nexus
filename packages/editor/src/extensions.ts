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

export class ExtensionHost {
  private extensions: EditorExtension[] = [];

  register(extension: EditorExtension) {
    this.extensions.push(extension);
  }

  getHandler(marker: MarkdownMarker): EditorExtension | undefined {
    return this.extensions.find(ext => ext.canHandle(marker));
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
