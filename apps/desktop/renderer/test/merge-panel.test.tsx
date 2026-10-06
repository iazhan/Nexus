// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergePanel } from '../src/workspace/MergePanel.js';
import { localeManager } from '../src/platform.js';

/**
 * 三路合并面板。
 *
 * 这里验的是**面板自己的行为**：默认处置怎么来、改选之后结果跟着变、apply 交出什么。
 * 重建的字节级正确性在 `packages/markdown/test/merge-reconstruct.test.ts`（那份是
 * 独立实现，两处一起对才说明规则本身对）。
 *
 * `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localeManager.setLocale('zh-CN');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: React.ReactElement): void {
  act(() => {
    root.render(ui);
  });
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function query<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function queryAll<T extends Element>(selector: string): T[] {
  return Array.from(container.querySelectorAll<T>(selector));
}

/** 长句子，免得短块因为 Levenshtein 敏感性掉到相似度阈值之外。 */
const BASE = '这一段说明讲的是缓存策略，以及它在读路径上的取舍。';
const MINE = '这一段说明讲的是缓存失效策略，以及它在读路径上的取舍。';
const THEIRS = '这一段说明讲的是缓存策略，以及它在写路径上的取舍。';

const doc = (...blocks: string[]): string => `${blocks.join('\n\n')}\n`;

describe('合并面板', () => {
  it('冲突行不预选：默认两边都不留，且计数提示出现', () => {
    const onApply = vi.fn();
    render(
      <MergePanel base={doc(BASE)} mine={doc(MINE)} theirs={doc(THEIRS)} onApply={onApply} onCancel={() => {}} />
    );

    expect(query('[data-merge-suggestion="conflict"]')).not.toBeNull();
    expect(query('[data-merge-conflict-count]')).not.toBeNull();

    // 冲突行的默认处置是 drop（两边都不留）—— 所以**没有任何内容侧**被预选，
    // 亮着的那个只能是 drop。替用户在冲突里选边站才是要避免的事。
    const active = queryAll('[data-merge-pick][aria-checked="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute('data-merge-pick')).toBe('drop');

    click(query('[data-merge-apply]'));
    expect(onApply).toHaveBeenCalledWith('');
  });

  it('只有一边改 → 建议那一边，apply 交出含该改动的内容', () => {
    const onApply = vi.fn();
    render(
      <MergePanel
        base={doc(BASE, '保持不动。')}
        mine={doc(MINE, '保持不动。')}
        theirs={doc(BASE, '保持不动。')}
        onApply={onApply}
        onCancel={() => {}}
      />
    );

    click(query('[data-merge-apply]'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const merged = onApply.mock.calls[0]![0] as string;
    expect(merged).toContain('失效');
    expect(merged).toContain('保持不动。');
  });

  it('改选 → 结果跟着变', () => {
    const onApply = vi.fn();
    render(
      <MergePanel base={doc(BASE)} mine={doc(MINE)} theirs={doc(THEIRS)} onApply={onApply} onCancel={() => {}} />
    );

    click(query('[data-merge-pick="theirs"]'));
    click(query('[data-merge-apply]'));
    expect(onApply.mock.calls[0]![0]).toContain('写路径');
  });

  it('两侧新增不同内容 → 默认 both，两边都留下', () => {
    const onApply = vi.fn();
    render(
      <MergePanel
        base={doc('锚点。')}
        mine={doc('锚点。', '我加的一段。')}
        theirs={doc('锚点。', '他加的一段。')}
        onApply={onApply}
        onCancel={() => {}}
      />
    );

    click(query('[data-merge-apply]'));
    const merged = onApply.mock.calls[0]![0] as string;
    expect(merged).toContain('我加的一段');
    expect(merged).toContain('他加的一段');
  });

  it('取消不写回任何东西', () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<MergePanel base={doc(BASE)} mine={doc(MINE)} theirs={doc(THEIRS)} onApply={onApply} onCancel={onCancel} />);

    click(query('.nexus-merge-actions button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('三份相同 → 每个块都有行，apply 交回逐字节相同的内容', () => {
    const src = doc('第一段。', '第二段。');
    const onApply = vi.fn();
    render(<MergePanel base={src} mine={src} theirs={src} onApply={onApply} onCancel={() => {}} />);

    expect(query('[data-merge-conflict-count]')).toBeNull();
    click(query('[data-merge-apply]'));
    expect(onApply).toHaveBeenCalledWith(src);
  });
});
