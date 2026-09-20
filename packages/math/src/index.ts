import katex from 'katex';
import type { EditorExtension, EditorExtensionControl, MarkdownMarker } from '@nexus/editor';
import 'katex/dist/katex.min.css';

export class MathExtension implements EditorExtension {
  id = 'nexus-math';

  canHandle(marker: MarkdownMarker): boolean {
    return marker.type === 'inline-math' || marker.type === 'block-math';
  }

  async load(): Promise<void> {
    // KaTeX is small enough that we can bundle it, but if we wanted to dynamically 
    // load fonts or css we could do it here.
    return Promise.resolve();
  }

  activate(marker: MarkdownMarker, container: HTMLElement, source: string): EditorExtensionControl {
    let currentSource = source;

    const render = () => {
      try {
        katex.render(currentSource, container, {
          throwOnError: false,
          displayMode: marker.type === 'block-math'
        });
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
