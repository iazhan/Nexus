// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@nexus/i18n';
import { InsertLinkPalette } from '../src/workspace/InsertLinkPalette.js';
import { localeManager } from '../src/platform.js';

/**
 * 插入链接的选目标面板。
 *
 * 这一层验的是**面板自己**：候选从哪来、过滤怎么做、键盘怎么走、选中之后把什么交给调用方。
 * 「拿到那篇文档之后写出来的链接对不对」在 `packages/editor` 的纯逻辑里，
 * 「整条链路在真机上通不通」在 `apps/desktop/test/insert-link.test.ts` —— 三处各答一个问题，
 * 合成一份的话，任一处坏了另外两处都会跟着红，反而看不出坏在哪。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译 ——
 * 写错了不会有人告诉你，注意别依赖编译器。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只关心 id / path / relativePath / name，其余给固定值。 */
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

describe('插入链接：选目标面板', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onPick: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let documents: ReturnType<typeof documentOf>[];

  const palette = () => container.querySelector<HTMLElement>('[data-insert-link-palette]');
  const input = () => container.querySelector<HTMLInputElement>('.nexus-insert-link-input')!;
  const items = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-insert-link-item]')).map((el) =>
      el.getAttribute('data-insert-link-item')
    );
  const activeItem = () =>
    container.querySelector<HTMLElement>('.nexus-insert-link-item-active')?.getAttribute(
      'data-insert-link-item'
    );

  /** 面板在 `useEffect` 里异步取文档，渲染后要让出一次微任务。 */
  const render = async () => {
    await act(async () => {
      root.render(<InsertLinkPalette onPick={onPick} onClose={onClose} />);
    });
  };

  const type = async (value: string) => {
    await act(async () => {
      const el = input();
      // 必须走原型上的 setter：React 在 input 元素上装了自己的 value 追踪器，
      // 直接 `el.value = x` 会让它以为「值没变」而跳过 onChange（受控组件不更新）。
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const keyDown = async (key: string) => {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  const mouseDown = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onPick = vi.fn();
    onClose = vi.fn();
    documents = [
      documentOf('notes/dma.md', 1),
      documentOf('notes/ethercat.md', 2),
      documentOf('archive/old.md', 3)
    ];
    (window as unknown as { nexus: unknown }).nexus = {
      listIndexedDocuments: vi.fn(async () => documents)
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件里改过 locale 的用例必须还原
    act(() => localeManager.setLocale('en-US'));
    vi.restoreAllMocks();
  });

  it('挂载即列出索引里的文档，按 relativePath 当键', async () => {
    await render();

    expect(palette()).not.toBeNull();
    expect(palette()!.getAttribute('aria-label')).toBe(translate('en-US', 'insertLink.title'));
    // 查询为空时 `rankByFuzzy` 保留全部（分数并列 0，顺序即输入顺序）
    expect(new Set(items())).toEqual(new Set(['notes/dma.md', 'notes/ethercat.md', 'archive/old.md']));
  });

  it('输入即过滤，命中不了的从列表里消失', async () => {
    await render();
    await type('ether');

    expect(items()).toEqual(['notes/ethercat.md']);
  });

  it('反面：一个字都不匹配时给出空态，而不是留一个空列表', async () => {
    await render();
    await type('zzzz');

    expect(items()).toEqual([]);
    expect(container.querySelector('.nexus-insert-link-empty')?.textContent).toBe(
      translate('en-US', 'insertLink.noMatch')
    );
  });

  it('索引为空时说的是另一句话 —— 「没有匹配」与「还没有索引」要能分开', async () => {
    documents = [];
    await render();

    expect(container.querySelector('.nexus-insert-link-empty')?.textContent).toBe(
      translate('en-US', 'insertLink.noIndex')
    );
  });

  it('上下键移动高亮，回车把当前那一条交给调用方', async () => {
    await render();
    await type('notes');
    const listed = items();
    expect(listed.length).toBe(2);

    expect(activeItem()).toBe(listed[0]);
    await keyDown('ArrowDown');
    expect(activeItem()).toBe(listed[1]);
    await keyDown('ArrowUp');
    expect(activeItem()).toBe(listed[0]);

    await keyDown('Enter');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].relativePath).toBe(listed[0]);
  });

  it('高亮不会越过列表两端', async () => {
    await render();
    await type('notes');

    await keyDown('ArrowUp');
    expect(activeItem()).toBe(items()[0]);
    await keyDown('ArrowDown');
    await keyDown('ArrowDown');
    await keyDown('ArrowDown');
    expect(activeItem()).toBe(items()[items().length - 1]);
  });

  it('查询变了之后高亮回到第一条 —— 否则会停在一个已不存在的下标上', async () => {
    await render();
    await type('notes');
    await keyDown('ArrowDown');
    expect(activeItem()).toBe(items()[1]);

    await type('arch');
    expect(items()).toEqual(['archive/old.md']);
    expect(activeItem()).toBe('archive/old.md');
  });

  it('点条目就是选中它，且**不**触发关闭 —— 关掉面板是调用方在插入之后做的事', async () => {
    await render();
    await mouseDown(container.querySelector('[data-insert-link-item="notes/dma.md"]')!);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].path).toBe('/vault/notes/dma.md');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape 关闭', async () => {
    await render();
    await keyDown('Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点遮罩关闭，点面板内部不关 —— 否则点列表项会先被遮罩卸掉', async () => {
    await render();

    await mouseDown(palette()!);
    expect(onClose).not.toHaveBeenCalled();

    await mouseDown(container.querySelector('.nexus-insert-link-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('挂载即聚焦输入框 —— 打开面板就是为了打字', async () => {
    await render();

    expect(document.activeElement).toBe(input());
  });
});
