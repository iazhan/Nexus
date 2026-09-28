// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit } from '@nexus/core';
import { SearchPanel } from '../src/workspace/SearchPanel.js';
import { localeManager } from '../src/platform.js';

/**
 * 搜索结果的**类型徽标**（P3-10）。
 *
 * 为什么这一层要有用例：P3-10 起附件也会出现在搜索结果里（被 Markdown 引用过的
 * PDF/DOCX 提取出的文本进了全文索引）。不标类型的话，用户看到「manual.pdf」会以为
 * 搜到的是**文件名**，点进去才发现命中的是正文里的字 —— 徽标就是用来消除这个误解的。
 *
 * 这里用打桩的 `window.nexus` 把 IPC 换掉，只验渲染。真机那一层
 * （`apps/desktop/test/p3-10-extraction-index.test.ts`）负责证明真实索引喂进来
 * 也是这个结果。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译 ——
 * 写错了不会有人告诉你，注意别依赖编译器。
 */

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let nextDocumentId = 1;

/** 只关心路径与类型，其余给固定值。`documentId` 递增 —— React 的 key 用它，重复会刷警告。 */
function hit(relativePath: string, overrides: Partial<SearchHit> = {}): SearchHit {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    documentId: nextDocumentId++,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: 'markdown',
    extractionStatus: 'none',
    ...overrides
  };
}

describe('搜索面板的类型徽标', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件里改过 locale 的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  /**
   * 渲染、输入查询、把防抖走完。
   *
   * 受控 input 必须走**原型上的原生 setter** 再派发 `input` 事件 —— 直接
   * `input.value = 'x'` 改的是 DOM 属性，React 的内部追踪值没变，`onChange`
   * 会被当成「值没变」而不触发。
   */
  async function search(query: string, hits: SearchHit[]): Promise<void> {
    (window as unknown as { nexus: unknown }).nexus = {
      searchIndex: vi.fn(async () => hits)
    };

    await act(async () => {
      root.render(<SearchPanel onOpenFile={vi.fn()} />);
    });

    const input = container.querySelector('.nexus-search-input') as HTMLInputElement | null;
    if (!input) throw new Error(`没渲染出搜索输入框：${container.innerHTML}`);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 等防抖（200ms）**真的**走完。
    //
    // 不用 `vi.useFakeTimers()`：`support/setup.ts` 里的 act 补丁靠等一个真实宏任务
    // 让 react-dom 提交 DOM，时钟被接管之后那个 `setTimeout(0)` 永远不 resolve，
    // 用例会超时（踩过）。真实等 250ms，三条用例总共多花不到 1 秒。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
  }

  /** 把结果行读成 `[文件名, 徽标]`。徽标为 `null` 表示这一行没有徽标。 */
  function readRows(): Array<[string | undefined, string | null]> {
    return Array.from(container.querySelectorAll('.nexus-search-hit')).map((row) => [
      row.querySelector('.nexus-search-hit-name')?.textContent ?? undefined,
      row.querySelector('.nexus-search-hit-badge')?.textContent ?? null
    ]);
  }

  it('附件命中带类型徽标，Markdown 命中不带', async () => {
    await search('dma', [
      hit('notes/dma.md', { type: 'markdown' }),
      hit('docs/manual.pdf', { type: 'pdf' }),
      hit('docs/spec.docx', { type: 'docx' }),
      hit('assets/logo.png', { type: 'image' })
    ]);

    // Markdown 是默认情形，带徽标只会制造噪音；其余三种都要标出来
    expect(readRows()).toEqual([
      ['dma.md', null],
      ['manual.pdf', 'PDF'],
      ['spec.docx', 'DOCX'],
      ['logo.png', 'Image']
    ]);
  });

  it('徽标跟随语言', async () => {
    await search('logo', [hit('assets/logo.png', { type: 'image' })]);
    const badge = () => container.querySelector('.nexus-search-hit-badge')?.textContent;

    // 单例默认 en-US
    expect(badge()).toBe('Image');

    act(() => {
      localeManager.setLocale('zh-CN');
    });
    // 复用 `document.type.*`，所以这里同时验了「没有另写一份类型名」
    expect(badge()).toBe('图片');
  });

  it('没有命中时不出任何徽标', async () => {
    await search('zzz', []);

    expect(readRows()).toEqual([]);
    expect(container.textContent).toContain('No matches');
  });
});
