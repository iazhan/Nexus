import mermaid from 'mermaid';
import {
  MERMAID_EXTENSION_ID,
  isMermaidMarker,
  type EditorExtension,
  type EditorExtensionControl,
  type MarkdownMarker
} from '@nexus/editor';

export class MermaidExtension implements EditorExtension {
  id = MERMAID_EXTENSION_ID;
  private static initialized = false;

  canHandle(marker: MarkdownMarker): boolean {
    // 谓词住在 @nexus/editor，理由同 @nexus/math：宿主得在本包被 import 之前就能判定。
    return isMermaidMarker(marker);
  }

  async load(): Promise<void> {
    if (!MermaidExtension.initialized) {
      mermaid.initialize({ startOnLoad: false, theme: 'default' });
      MermaidExtension.initialized = true;
    }
    return Promise.resolve();
  }

  activate(_marker: MarkdownMarker, container: HTMLElement, source: string): EditorExtensionControl {
    let currentSource = source;
    const renderId = `mermaid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const render = async () => {
      try {
        const { svg } = await mermaid.render(renderId, currentSource);
        container.innerHTML = svg;
      } catch (err) {
        container.textContent = String(err);
      }
    };

    render();

    return {
      update(newSource: string) {
        currentSource = newSource;
        render();
      },
      destroy() {
        container.innerHTML = '';
      }
    };
  }
}
