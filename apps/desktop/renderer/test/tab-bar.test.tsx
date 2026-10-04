// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@nexus/i18n';
import { TabBar } from '../src/workspace/TabBar.js';
import type { WorkspaceDocument } from '../src/workspace/store.js';
import { localeManager } from '../src/platform.js';

/**
 * 标签栏的**渲染契约**。
 *
 * 真机那条（`apps/desktop/test/workspace-tabs.test.ts`）只证明「真实链路喂进来也是这个结果」，
 * 而「零个文档画什么、一个文档画什么」是组件的渲染分支，只有打桩这一层能穷举 —— 真机
 * 要凑出「一个文档都没有」得先把标签页关干净，代价比断言本身贵得多。
 *
 * 这里钉三件事：
 *
 * 1. **零个文档不渲染，一个文档就渲染**（2026-10-04 起标签栏常驻）。正反两面都要断言 ——
 *    只断言「一个文档时有栏」对「零个文档也画一条空栏」同样成立。
 * 2. **脏点与保存态同源**：`hasUnsavedChanges()` 说未保存的才打点。它是「缓冲区里有磁盘上
 *    没有的东西」这一条判据，关标签页前要不要先落盘、改名要跳过哪些文档也读它 ——
 *    所以在 `readonly` 与 `clean` 上必须**没有**点，否则那条判据被抄成了第二份。
 * 3. **关闭按钮不冒泡成激活**：`onClick` 里少了 `stopPropagation` 时，点一下 × 会先把
 *    那个标签激活再去关它 —— 用户看到的是「闪一下才关」，而两个回调各自都对。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('标签栏渲染契约', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onActivate: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onActivate = vi.fn();
    onClose = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    // 单例：本文件改过 locale 的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  const t = (key: string): string => translate(localeManager.locale, key);

  /**
   * 造一份样例文档。
   *
   * `TabBar` 只读 `id` / `filePath` / `kind` / `saveState` 四样（其余靠 props 传下来的
   * 整份文档原样透传），所以这里不必造真的 `MarkdownDocumentSession` —— 造了反而要把
   * 编辑器包拖进来。
   */
  const doc = (overrides: Record<string, unknown> = {}): WorkspaceDocument =>
    ({
      id: 'doc-1',
      filePath: 'C:/vault/note.md',
      kind: 'editor',
      type: 'markdown',
      session: null,
      saveState: 'clean',
      saveError: null,
      readOnly: false,
      ...overrides
    }) as unknown as WorkspaceDocument;

  const render = (documents: WorkspaceDocument[], activeId: string | null = null) => {
    act(() => {
      root.render(
        <TabBar
          documents={documents}
          activeId={activeId ?? documents[0]?.id ?? null}
          onActivate={onActivate}
          onClose={onClose}
        />
      );
    });
  };

  const bar = () => container.querySelector('.nexus-tab-bar');
  const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('.nexus-tab'));
  const activeTabs = () => container.querySelectorAll('.nexus-tab-active').length;
  const dotted = () => container.querySelectorAll('.nexus-tab-dot').length;

  it('零个文档不渲染，一个文档就渲染', () => {
    render([]);
    // 空栏没有可点的东西，而那种状态下主区本来就在画空态
    expect(bar()).toBeNull();

    // 反面：一个文档必须渲染 —— 少了这一半，「永远返回 null」也能让上面那句通过
    render([doc()]);
    expect(bar()).not.toBeNull();
    expect(tabs()).toHaveLength(1);
  });

  it('一个文档时那一条就是当前文档', () => {
    render([doc()]);

    expect(tabs()[0]!.classList.contains('nexus-tab-active')).toBe(true);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(activeTabs()).toBe(1);
    // 提示给的是完整路径，标签上只留文件名
    expect(tabs()[0]!.getAttribute('title')).toBe('C:/vault/note.md');
    expect(tabs()[0]!.querySelector('.nexus-tab-name')!.textContent).toBe('note.md');
  });

  it('未命名文档显示占位名，不是空字符串', () => {
    render([doc({ filePath: null })]);

    expect(tabs()[0]!.querySelector('.nexus-tab-name')!.textContent).toBe(t('tab.untitled'));
    // 没有路径时 title 退回落到的名字，而不是 "null"
    expect(tabs()[0]!.getAttribute('title')).toBe(t('tab.untitled'));
  });

  it('脏点只出现在「缓冲区里有磁盘上没有的东西」时', () => {
    const unsaved = ['dirty', 'saving', 'error', 'external-changed'] as const;
    for (const saveState of unsaved) {
      render([doc({ saveState })]);
      expect(dotted(), `${saveState} 该打点`).toBe(1);
    }

    // 反面：这两种都是「磁盘与内存一致」，打点会让人以为有东西没保存
    for (const saveState of ['clean', 'readonly'] as const) {
      render([doc({ saveState })]);
      expect(dotted(), `${saveState} 不该打点`).toBe(0);
    }
  });

  it('点标签激活；点关闭按钮只关闭，不顺手激活', () => {
    const documents = [doc(), doc({ id: 'doc-2', filePath: 'C:/vault/other.md' })];
    render(documents, 'doc-1');

    act(() => {
      tabs()[1]!.click();
    });
    expect(onActivate).toHaveBeenCalledWith('doc-2');
    expect(onClose).not.toHaveBeenCalled();

    onActivate.mockClear();
    act(() => {
      tabs()[0]!.querySelector<HTMLButtonElement>('.nexus-tab-close')!.click();
    });
    expect(onClose).toHaveBeenCalledWith('doc-1');
    // 关键：关掉一个后台标签不该把它切到前台 —— 少了 stopPropagation 就会
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('中键关闭标签', () => {
    render([doc(), doc({ id: 'doc-2' })]);

    act(() => {
      tabs()[0]!.dispatchEvent(
        new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
      );
    });
    expect(onClose).toHaveBeenCalledWith('doc-1');

    // 反面：左键的 auxclick 不是关闭手势（浏览器对左键也会发 auxclick）
    onClose.mockClear();
    act(() => {
      tabs()[0]!.dispatchEvent(
        new MouseEvent('auxclick', { button: 0, bubbles: true, cancelable: true })
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
