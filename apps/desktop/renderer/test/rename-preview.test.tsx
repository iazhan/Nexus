// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@nexus/i18n';
import type { RenameFileChange, RenameFileSkip } from '../../ipc/channels.js';
import { RenamePreview } from '../src/workspace/RenamePreview.js';
import { localeManager } from '../src/platform.js';

/**
 * 改名确认屏的渲染。
 *
 * 为什么要有这一层：真机用例只能证明「弹出来了、点了确认」，而这一屏的全部价值
 * 就在**它画了什么** —— diff 有没有把改动行摆出来、跳过项有没有如实说。
 * 画错了不会有任何报错，只会让用户点下一个他不理解的确认。
 *
 * 文案断言一律走 `translate(localeManager.locale, ...)`，不写死中文 ——
 * 语言是可切的，写死会在换语言时假红。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string>): string =>
  translate(localeManager.locale, key, vars);

function change(relativePath: string, before: string, after: string): RenameFileChange {
  return { path: `/vault/${relativePath}`, relativePath, before, after };
}

describe('改名确认屏', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onConfirm: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onConfirm = vi.fn();
    onCancel = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(changes: RenameFileChange[], skipped: RenameFileSkip[] = []): void {
    act(() => {
      root.render(
        <RenamePreview
          fromName="dma.md"
          toName="dma-2.md"
          changes={changes}
          skipped={skipped}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      );
    });
  }

  /** 每一行的 `{ kind, text }`，按画出来的顺序。 */
  function diffRows(): { kind: string; text: string }[] {
    return Array.from(container.querySelectorAll('.nexus-rename-diff > li')).map((row) => ({
      kind: row.className.replace('nexus-diff-', ''),
      text: row.querySelector('.nexus-diff-text')?.textContent ?? ''
    }));
  }

  it('「旧 → 新」两个名字都画出来，改的是哪一头一眼可见', () => {
    render([change('notes/a.md', '[[dma]]', '[[dma-2]]')]);

    expect(container.querySelector('.nexus-rename-old')?.textContent).toBe('dma.md');
    expect(container.querySelector('.nexus-rename-new')?.textContent).toBe('dma-2.md');
  });

  it('只画改动行，不画没动的行 —— 否则真正要看的那一行会被埋掉', () => {
    render([
      change(
        'notes/a.md',
        ['# 标题', '', '前文 [[dma]] 后文', '', '结尾'].join('\n'),
        ['# 标题', '', '前文 [[dma-2]] 后文', '', '结尾'].join('\n')
      )
    ]);

    expect(diffRows()).toEqual([
      { kind: 'removed', text: '前文 [[dma]] 后文' },
      { kind: 'added', text: '前文 [[dma-2]] 后文' }
    ]);
    // 「# 标题」这类没动的行不该出现
    expect(container.textContent).not.toContain('# 标题');
  });

  it('每篇改动各自成段，段落带相对路径锚点', () => {
    render([
      change('notes/a.md', '[[dma]]', '[[dma-2]]'),
      change('notes/b.md', '见 [[dma]]', '见 [[dma-2]]')
    ]);

    const items = Array.from(container.querySelectorAll('[data-rename-path]'));
    expect(items.map((item) => item.getAttribute('data-rename-path'))).toEqual([
      'notes/a.md',
      'notes/b.md'
    ]);
    // 文件名画在段落标题里，用户才知道这一段是谁的
    expect(container.querySelector('.nexus-rename-file')?.textContent).toBe('notes/a.md');
  });

  it('篇数用「将改写 N 篇文档」那一句，不自己拼', () => {
    render([change('a.md', '[[dma]]', '[[dma-2]]'), change('b.md', '[[dma]]', '[[dma-2]]')]);

    expect(container.querySelector('.nexus-rename-count')?.textContent).toBe(
      t('workspace.renameDialogCount', { count: '2' })
    );
  });

  it('跳过项如实列出来，按原因各一行', () => {
    render(
      [change('a.md', '[[dma]]', '[[dma-2]]')],
      [
        { relativePath: 'x.md', reason: 'dirty' },
        { relativePath: 'y.md', reason: 'dirty' },
        { relativePath: 'z.md', reason: 'unresolved', target: '[[dma|x]]' }
      ]
    );

    const skips = Array.from(container.querySelectorAll('[data-rename-skips] li')).map(
      (item) => item.textContent
    );
    expect(skips).toEqual([
      t('workspace.renameSkipDirty', { count: '2' }),
      t('workspace.renameSkipUnresolved', { count: '1' })
    ]);
  });

  it('没有跳过项时那一块根本不画（不留一个空标题）', () => {
    render([change('a.md', '[[dma]]', '[[dma-2]]')]);

    expect(container.querySelector('[data-rename-skips]')).toBeNull();
  });

  it('确认与取消各回各的回调', () => {
    render([change('a.md', '[[dma]]', '[[dma-2]]')]);

    const confirm = container.querySelector<HTMLElement>('[data-rename-confirm]')!;
    act(() => {
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('取消按钮不触发确认', () => {
    render([change('a.md', '[[dma]]', '[[dma-2]]')]);

    const buttons = Array.from(container.querySelectorAll<HTMLElement>('.nexus-rename-button'));
    const cancel = buttons.find((button) => button !== container.querySelector('[data-rename-confirm]'))!;
    act(() => {
      cancel.click();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /**
   * 默认焦点在**取消**上：这一屏点下去会改别人的文件。打开它的正是内联输入框里
   * 那一次 Enter，同一个键连着按两下不该直接落盘。
   */
  it('默认焦点给取消，不给确认', () => {
    render([change('a.md', '[[dma]]', '[[dma-2]]')]);

    expect(document.activeElement?.textContent).toBe(t('workspace.renameCancel'));
  });
});
