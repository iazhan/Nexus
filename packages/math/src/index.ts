import katex from 'katex';
import {
  MATH_EXTENSION_ID,
  isMathMarker,
  type EditorExtension,
  type EditorExtensionControl,
  type MarkdownMarker
} from '@nexus/editor';
import 'katex/dist/katex.min.css';

export class MathExtension implements EditorExtension {
  id = MATH_EXTENSION_ID;

  canHandle(marker: MarkdownMarker): boolean {
    // 谓词住在 @nexus/editor：宿主必须能在本包被 import 之前就判断「这个 marker 归谁」，
    // 否则为了拿判定就得先把 katex 拖进来，懒加载失效。
    return isMathMarker(marker);
  }

  async load(): Promise<void> {
    // 本包整体是动态 import 进来的（见 App.tsx 的 registerLazy），所以 katex 的 JS
    // 与 `katex.min.css`（含一整套字体）只在文档真的出现公式时才会下载。
    // 这里没有额外的初始化步骤 —— katex 是纯函数式渲染，不需要 `initialize()` 之类的握手。
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
