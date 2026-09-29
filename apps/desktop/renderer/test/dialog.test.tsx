// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dialog } from '../src/components/Dialog.js';

/**
 * 弹层原语（P4-05 抽出）。三处易错的地方各有一条：
 *
 * - Escape 挂在**面板**上（`preventDefault()` 能被外层的 window 级监听看见），不是 window ——
 *   否则设置页那个 Escape 会跟着一起关，两层一起消失。
 * - 焦点陷阱的循环判据要包含「焦点跑到面板外」这一种。
 * - 关闭后焦点归还到**打开前**的元素。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const Harness: React.FC<{ initialFocusSelector?: string; onEscape?: () => void }> = ({
  initialFocusSelector,
  onEscape
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-opener="" onClick={() => setOpen(true)}>
        open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onEscape?.();
          setOpen(false);
        }}
        label="test dialog"
        panelClassName="nexus-test-dialog"
        initialFocusSelector={initialFocusSelector}
      >
        <button type="button" data-first="">
          first
        </button>
        <button type="button" data-last="">
          last
        </button>
      </Dialog>
    </>
  );
};

function render(ui: React.ReactElement): void {
  act(() => {
    root.render(ui);
  });
}

function click(target: Element | null): void {
  act(() => {
    (target as HTMLElement).click();
  });
}

function keydown(target: Element, key: string, shiftKey = false): void {
  act(() => {
    // `cancelable` 必须为真，否则 `preventDefault()` 是空操作，`defaultPrevented` 恒 false。
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

describe('Dialog 原语', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('关闭时什么都不渲染', () => {
    render(<Harness />);

    expect(container.querySelector('[data-dialog]')).toBeNull();
    expect(container.querySelector('[data-dialog-backdrop]')).toBeNull();
  });

  it('打开时给出 role="dialog" 与 aria-modal', () => {
    render(<Harness />);
    click(container.querySelector('[data-opener]'));

    const panel = container.querySelector('[data-dialog]');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.getAttribute('aria-label')).toBe('test dialog');
  });

  it('打开后聚焦 initialFocusSelector 指定的元素，缺省聚焦第一个可聚焦项', () => {
    render(<Harness initialFocusSelector="[data-last]" />);
    click(container.querySelector('[data-opener]'));
    expect(document.activeElement).toBe(container.querySelector('[data-last]'));

    act(() => root.unmount());
    container.remove();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render(<Harness />);
    click(container.querySelector('[data-opener]'));
    expect(document.activeElement).toBe(container.querySelector('[data-first]'));
  });

  it('Escape 关面板并 preventDefault —— 外层 window 监听据此跳过', () => {
    let closed = 0;
    render(<Harness onEscape={() => { closed += 1; }} />);
    click(container.querySelector('[data-opener]'));

    const panel = container.querySelector('[data-dialog]') as HTMLElement;
    let prevented = false;
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      panel.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });

    expect(closed).toBe(1);
    expect(prevented).toBe(true);
    expect(container.querySelector('[data-dialog]')).toBeNull();
  });

  /** 挂 window 的话这里会数到 2（面板一次、window 一次）—— 设置页的 Escape 会跟着关。 */
  it('Escape 只被面板处理一次，window 上收不到未标记的事件', () => {
    let windowSeen = 0;
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      if (!event.defaultPrevented) windowSeen += 1;
    };
    window.addEventListener('keydown', onWindowKeyDown);

    try {
      render(<Harness />);
      click(container.querySelector('[data-opener]'));
      keydown(container.querySelector('[data-dialog]') as HTMLElement, 'Escape');
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }

    expect(windowSeen).toBe(0);
  });

  it('Tab 在最后一项上回到第一项，Shift+Tab 反向', () => {
    render(<Harness />);
    click(container.querySelector('[data-opener]'));
    const first = container.querySelector('[data-first]') as HTMLElement;
    const last = container.querySelector('[data-last]') as HTMLElement;

    last.focus();
    keydown(last, 'Tab');
    expect(document.activeElement).toBe(first);

    keydown(first, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('点背板关闭，点面板本身不关闭', () => {
    render(<Harness />);
    click(container.querySelector('[data-opener]'));

    click(container.querySelector('.nexus-test-dialog'));
    expect(container.querySelector('[data-dialog]')).not.toBeNull();

    click(container.querySelector('[data-dialog-backdrop]'));
    expect(container.querySelector('[data-dialog]')).toBeNull();
  });

  it('关闭后焦点归还到打开前的元素', () => {
    render(<Harness />);
    const opener = container.querySelector('[data-opener]') as HTMLElement;
    opener.focus();
    click(opener);
    expect(document.activeElement).not.toBe(opener);

    keydown(container.querySelector('[data-dialog]') as HTMLElement, 'Escape');
    expect(document.activeElement).toBe(opener);
  });

  it('placement 落到 data 属性与类名上', () => {
    act(() => {
      root.render(
        <Dialog open onClose={() => {}} label="top" placement="top">
          <button type="button">x</button>
        </Dialog>
      );
    });

    expect(container.querySelector('[data-dialog]')?.getAttribute('data-dialog-placement')).toBe(
      'top'
    );
    expect(container.querySelector('.nexus-dialog-backdrop-top')).not.toBeNull();
  });
});
