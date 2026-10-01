// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagsPanel } from '../src/workspace/TagsPanel.js';
import { localeManager } from '../src/platform.js';

/**
 * 标签面板的**外部展开**（编辑器里 Ctrl+点击标签）。
 *
 * 为什么这一层要有用例：`focusTag` 走的是「外部把展开态顶进去」这条路，而面板自己
 * 也有一个展开态。两者共用 `expandedTag`，所以真正的风险是**点了没反应**——
 * 尤其是「先手动收起、再点同一个标签」：标签名一样，只有 `seq` 变了。
 *
 * 这里用打桩的 `window.nexus` 换掉 IPC，只验渲染。真机那一层
 * （`apps/desktop/test/tags-panel.test.ts`）负责证明真实索引喂进来也是这个结果。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译 ——
 * 写错了不会有人告诉你，注意别依赖编译器。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只关心 id / path / relativePath，其余给固定值。 */
function documentOf(relativePath: string, id: number) {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: relativePath,
    extractionStatus: 'none'
  };
}

describe('标签面板的外部展开', () => {
  let container: HTMLDivElement;
  let root: Root;
  let findDocumentsByTag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    findDocumentsByTag = vi.fn(async () => [documentOf('a.md', 1), documentOf('b.md', 2)]);
    (window as unknown as { nexus: unknown }).nexus = {
      listTags: vi.fn(async () => [
        { tag: 'dma', count: 2 },
        { tag: 'ethercat', count: 1 }
      ]),
      findDocumentsByTag
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件里改过 locale 的用例必须还原
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  /** 渲染并等 `listTags()` 那一次异步读完。 */
  async function render(
    focusTag: { tag: string; seq: number } | null,
    onOpenDocument: (filePath: string, tag: string) => void = vi.fn()
  ): Promise<void> {
    await act(async () => {
      root.render(
        <TagsPanel onOpenDocument={onOpenDocument} revision={0} focusTag={focusTag} />
      );
    });
  }

  const expandedNames = () =>
    Array.from(container.querySelectorAll('.nexus-tag-name')).map((el) => el.textContent);

  const openDocuments = () =>
    Array.from(container.querySelectorAll('.nexus-tag-documents .nexus-backlink-item')).map(
      (el) => el.textContent
    );

  it('列出标签与文档数，默认一个都不展开', async () => {
    await render(null);

    expect(expandedNames()).toEqual(['#dma', '#ethercat']);
    expect(openDocuments()).toEqual([]);
    expect(findDocumentsByTag).not.toHaveBeenCalled();
  });

  it('focusTag 顶进来时展开该标签并列出文档', async () => {
    await render({ tag: 'dma', seq: 1 });

    expect(openDocuments()).toEqual(['a.md', 'b.md']);
    expect(findDocumentsByTag).toHaveBeenCalledWith('dma');
  });

  it('先手动收起、再点同一个标签仍然展开 —— 靠 seq 而不是标签名', async () => {
    await render({ tag: 'dma', seq: 1 });
    expect(openDocuments()).toEqual(['a.md', 'b.md']);

    // 用户手动收起
    await act(async () => {
      (container.querySelector('.nexus-tag-item') as HTMLButtonElement).click();
    });
    expect(openDocuments()).toEqual([]);

    // 编辑器里再点一次同一个标签：标签名没变，只有 seq 变了
    await render({ tag: 'dma', seq: 2 });
    expect(openDocuments()).toEqual(['a.md', 'b.md']);
  });

  it('切到另一个标签时展开的是新的那个', async () => {
    await render({ tag: 'dma', seq: 1 });
    await render({ tag: 'ethercat', seq: 2 });

    expect(openDocuments()).toEqual(['a.md', 'b.md']);
    expect(findDocumentsByTag).toHaveBeenLastCalledWith('ethercat');
  });

  it('点文档时把**被点的那个标签**一并交出去', async () => {
    // 一篇文档可以带多个标签，宿主需要知道该定位到哪一个 —— 只给路径的话，
    // 打开后就只能猜（或跳到文档里第一个标签，而那未必是用户点的那行）。
    const onOpenDocument = vi.fn();
    await render({ tag: 'ethercat', seq: 1 }, onOpenDocument);

    await act(async () => {
      const item = container.querySelector(
        '.nexus-tag-documents .nexus-backlink-item'
      ) as HTMLButtonElement;
      item.click();
    });

    expect(onOpenDocument).toHaveBeenCalledWith('/vault/a.md', 'ethercat');
  });
});

/**
 * happy-dom 里 `getBoundingClientRect()` 全是 0，几何得自己钉。
 * 面板视口固定 0–100；`#dma` 那一项的位置由 `tagTop` 控制，用例中间可以改。
 */
const rect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({})
  }) as DOMRect;

let tagTop = 0;

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const element = this as HTMLElement;
    if (element.classList?.contains('nexus-sidebar-list')) return rect(0, 100);
    if (element.dataset?.tag === 'dma') return rect(tagTop, tagTop + 20);
    return rect(0, 0);
  });
}

describe('把外部展开的标签滚进面板自己的视口', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    tagTop = 0;

    (window as unknown as { nexus: unknown }).nexus = {
      listTags: vi.fn(async () => [
        { tag: 'dma', count: 2 },
        { tag: 'ethercat', count: 1 }
      ]),
      findDocumentsByTag: vi.fn(async () => [documentOf('a.md', 1)])
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    vi.restoreAllMocks();
  });

  const render = async (focusTag: { tag: string; seq: number } | null): Promise<void> => {
    await act(async () => {
      root.render(<TagsPanel onOpenDocument={vi.fn()} revision={0} focusTag={focusTag} />);
    });
  };

  const list = () => container.querySelector<HTMLElement>('.nexus-sidebar-list')!;

  it('标签项在视口下方时往下滚', async () => {
    stubLayout();
    tagTop = 300; // 面板视口 0–100，标签项占 300–320
    await render({ tag: 'dma', seq: 1 });

    expect(list().scrollTop).toBe(220); // 320（项底边）− 100（视口底边）
  });

  it('标签项在视口上方时往回滚', async () => {
    stubLayout();
    tagTop = 300;
    await render({ tag: 'dma', seq: 1 });
    expect(list().scrollTop).toBe(220);

    tagTop = -50; // 标签项占 −50–−30
    await render({ tag: 'dma', seq: 2 });
    expect(list().scrollTop).toBe(170); // 220 − (0 − (−50))
  });

  it('标签项已经在视口里时一动不动', async () => {
    // 这条是「nearest」语义的另一半：只在真的看不见时才动，
    // 否则用户每次点标签都会被面板拽一下。
    stubLayout();
    tagTop = 40; // 40–60，落在 0–100 里
    await render({ tag: 'dma', seq: 1 });

    expect(list().scrollTop).toBe(0);
  });

  it('用户自己展开别的标签时不把视口拽回 focusTag 那一项', async () => {
    stubLayout();
    tagTop = 300;
    await render({ tag: 'dma', seq: 1 });
    expect(list().scrollTop).toBe(220);

    await act(async () => {
      const items = Array.from(container.querySelectorAll<HTMLElement>('.nexus-tag-item'));
      items.find((element) => element.dataset.tag === 'ethercat')!.click();
    });

    expect(list().scrollTop).toBe(220);
  });

  it('focusTag 为 null 时不滚', async () => {
    stubLayout();
    tagTop = 300;
    await render(null);

    expect(list().scrollTop).toBe(0);
  });
});
