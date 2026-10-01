// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  type EditorSurfaceKind,
  type LinkNavigationRequest,
  type SessionEditorViewHandle
} from '../src/index.js';

interface Probe {
  handle: SessionEditorViewHandle;
  /** 扩展处理完、CodeMirror 介入之前那一刻的 defaultPrevented。 */
  wasPrevented: () => boolean;
}

function mount(
  source: string,
  options: {
    surfaceKind?: EditorSurfaceKind;
    navigator?: (request: LinkNavigationRequest) => boolean | void;
  } = {}
): Probe {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const session = new MarkdownDocumentSession(source);
  const handle = createSessionEditorView({
    parent,
    session,
    surfaceId: `tag-${Math.random().toString(36).slice(2, 9)}`,
    surfaceKind: options.surfaceKind ?? 'visual',
    ...(options.navigator ? { linkNavigator: options.navigator } : {})
  });

  // 与链接导航同一套探针：CodeMirror 自己也会在 mousedown 上 preventDefault，
  // 事件派发结束后从外部读分不清是谁吞的。
  let prevented = false;
  handle.view.dom.addEventListener(
    'mousedown',
    (event) => {
      prevented = event.defaultPrevented;
    },
    true
  );

  return { handle, wasPrevented: () => prevented };
}

/** 高亮出来的标签元素，按出现顺序。 */
function tagElements(probe: Probe): HTMLElement[] {
  return [...probe.handle.view.dom.querySelectorAll<HTMLElement>('.cm-nexus-tag')];
}

function dispatchMouseDown(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })
  );
}

describe('标签高亮', () => {
  it('给 `#标签` 加上装饰，并带上归一化后的标签名', () => {
    const probe = mount('这是 #DMA 相关。');
    const tags = tagElements(probe);

    expect(tags).toHaveLength(1);
    expect(tags[0]?.textContent).toBe('#DMA');
    // 属性值是归一化后的：宿主直接拿它去查索引，不必再处理大小写与 `#`
    expect(tags[0]?.dataset.tag).toBe('dma');

    probe.handle.destroy();
  });

  it('同一个标签出现多次就高亮多处', () => {
    const probe = mount('#a 与 #a 与 #b');
    expect(tagElements(probe)).toHaveLength(3);
    probe.handle.destroy();
  });

  it('围栏代码块里的 `#` 不高亮 —— 与索引判据一致', () => {
    const probe = mount(['```c', '#include <stdio.h>', '```', '#real'].join('\n'));
    const tags = tagElements(probe);

    expect(tags.map((el) => el.dataset.tag)).toEqual(['real']);
    probe.handle.destroy();
  });

  it('行内代码里的 `#` 不高亮', () => {
    const probe = mount('写 `#include` 得到 #c语言');
    const tags = tagElements(probe);

    expect(tags.map((el) => el.dataset.tag)).toEqual(['c语言']);
    probe.handle.destroy();
  });

  it('ATX 标题与 URL 片段都不是标签', () => {
    const probe = mount(['# 一级标题', '见 https://example.com/page#anchor'].join('\n'));
    expect(tagElements(probe)).toHaveLength(0);
    probe.handle.destroy();
  });

  it('Source 面同样高亮', () => {
    const probe = mount('这是 #dma 相关。', { surfaceKind: 'source' });
    const tags = tagElements(probe);

    expect(tags).toHaveLength(1);
    expect(tags[0]?.dataset.tag).toBe('dma');
    probe.handle.destroy();
  });

  it('改了文档之后高亮跟着更新', () => {
    const probe = mount('这是 #dma 相关。');
    expect(tagElements(probe)).toHaveLength(1);

    probe.handle.view.dispatch({
      changes: { from: 0, to: probe.handle.view.state.doc.length, insert: '没有标签了' }
    });

    expect(tagElements(probe)).toHaveLength(0);
    probe.handle.destroy();
  });
});

describe('Ctrl/Cmd + 左键点击标签', () => {
  it('把归一化后的标签名与 kind: tag 交给宿主', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mount('这是 #DMA 相关。', {
      navigator: (request) => {
        received.push(request);
        return true;
      }
    });

    dispatchMouseDown(tagElements(probe)[0]!, { ctrlKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]?.href).toBe('dma');
    expect(received[0]?.kind).toBe('tag');
    expect(probe.wasPrevented()).toBe(true);

    probe.handle.destroy();
  });

  it('普通点击不导航 —— 光标要能落进标签里改字', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mount('这是 #dma 相关。', {
      navigator: (request) => {
        received.push(request);
        return true;
      }
    });

    dispatchMouseDown(tagElements(probe)[0]!);

    expect(received).toHaveLength(0);
    expect(probe.wasPrevented()).toBe(false);

    probe.handle.destroy();
  });

  it('宿主不处理时不吞事件', () => {
    const probe = mount('这是 #dma 相关。', { navigator: () => false });

    dispatchMouseDown(tagElements(probe)[0]!, { ctrlKey: true });

    expect(probe.wasPrevented()).toBe(false);
    probe.handle.destroy();
  });

  it('代码块里的 `#` 点不动', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mount(['```c', '#include <stdio.h>', '```'].join('\n'), {
      navigator: (request) => {
        received.push(request);
        return true;
      }
    });

    expect(tagElements(probe)).toHaveLength(0);
    expect(received).toHaveLength(0);
    probe.handle.destroy();
  });
});
