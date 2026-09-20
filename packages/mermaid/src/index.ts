import mermaid from 'mermaid';
import type { EditorExtension, EditorExtensionControl, MarkdownMarker } from '@nexus/editor';

export class MermaidExtension implements EditorExtension {
  id = 'nexus-mermaid';
  private static initialized = false;

  canHandle(marker: MarkdownMarker): boolean {
    if (marker.type === 'code-fence') {
      return marker.language?.toLowerCase() === 'mermaid';
    }
    return false;
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
    let renderId = `mermaid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

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
