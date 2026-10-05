// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@nexus/i18n';
import {
  SELECTION_ACTION_SPECS,
  SelectionToolbar,
  placeSelectionToolbar,
  type AnchorRect,
  type SelectionAction,
  type SelectionAnchor
} from '../src/editor/SelectionToolbar.js';
import { localeManager } from '../src/platform.js';

/**
 * 选区上下文条的**渲染契约**（2026-10-03）。
 *
 * 这一条与常驻栏是两种形态，所以钉的东西也不一样：
 *
 * 1. **动作集恰好等于 §3.1 上表**（正反两面）。`SELECTION_ACTION_SPECS` 是那张表的唯一出处，
 *    App 与这里都从它取 —— 断言写死字面量，删掉表里一项就会红。
 * 2. **翻转靠 `top` 与选区 `bottom` 的关系判**，不是靠某个 class 存在与否：
 *    后者只说明代码走到了哪一支，不说明用户看到的位置对不对。
 * 3. **关闭只认「点外部」**，条内部的按下不算 —— 否则条先被卸掉，按钮的 `click` 永远到不了。
 * 4. **原子选区下格式按钮禁用**（P0-3 判据 ⑤）。
 * 5. **焦点保持**（P0-4）：拦在 `mousedown` 上。happy-dom 不实现鼠标默认动作，
 *    所以那条得自己补（见 `pressLeftButton`）。
 * 6. **激活态单一派生**（判据 36）：视觉类名与 `aria-pressed` 出自同一个布尔。
 *
 * **定位在 happy-dom 里是「零尺寸」这一支**：`getBoundingClientRect()` 全是 0，
 * 所以条高按 0 算、翻转阈值变成 `anchor.top < 16`。这不是妥协 ——
 * 真机上的尺寸差异由 `placeSelectionToolbar` 的纯函数用例单独钉住。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string): string => translate(localeManager.locale, key);

/** 视口中段的一个选区包围盒（不会触发翻转）。 */
const MID_RECT: AnchorRect = { top: 400, bottom: 420, left: 300, right: 400 };
/** 贴着可用区域顶边的选区（上方放不下，该翻到下方）。 */
const TOP_RECT: AnchorRect = { top: 2, bottom: 20, left: 300, right: 400 };

const MID_ANCHOR: SelectionAnchor = { rect: MID_RECT, minTop: 0 };
const TOP_ANCHOR: SelectionAnchor = { rect: TOP_RECT, minTop: 0 };

const actionsFromSpecs = (
  disabled = false,
  pressed: readonly string[] = []
): SelectionAction[] =>
  SELECTION_ACTION_SPECS.map((spec) => ({
    id: spec.id,
    label: t(spec.labelKey),
    icon: spec.icon,
    disabled,
    pressed: spec.format ? pressed.includes(spec.format) : undefined
  }));

describe('选区上下文条：定位（纯函数）', () => {
  const size = { width: 200, height: 32 };
  const viewport = { width: 1024, height: 768 };

  it('默认放在选区上方，横向以选区中心对齐', () => {
    const placement = placeSelectionToolbar(MID_RECT, size, viewport);

    expect(placement.flipped).toBe(false);
    // 400 - 8（呼吸位）- 32（条高）
    expect(placement.top).toBe(360);
    // 中心 350 - 半宽 100
    expect(placement.left).toBe(250);
  });

  it('上方放不下时翻到选区下方', () => {
    const placement = placeSelectionToolbar(TOP_RECT, size, viewport);

    expect(placement.flipped).toBe(true);
    expect(placement.top).toBeGreaterThan(TOP_RECT.bottom);
    expect(placement.top).toBe(TOP_RECT.bottom + 8);
  });

  it('翻转的判据是「算出来的 top 越过上沿」，不是「选区贴着顶边」', () => {
    // 选区离顶边 48、条高 32 时，上方算出来正好落在边距线上，**不该翻**
    const atEdge = placeSelectionToolbar(
      { top: 48, bottom: 60, left: 0, right: 0 },
      { width: 0, height: 32 },
      viewport
    );
    expect(atEdge.flipped).toBe(false);
    expect(atEdge.top).toBe(8);
  });

  it('上沿抬到编辑器顶边：首行选区不再压住常驻工具栏', () => {
    // 编辑器盒子从 y=75 开始，选区在首行（y=85）
    const placement = placeSelectionToolbar(
      { top: 85, bottom: 105, left: 300, right: 400 },
      size,
      viewport,
      75
    );

    expect(placement.flipped).toBe(true);
    expect(placement.top).toBeGreaterThan(105);
  });

  it('上沿抬高不影响中段选区', () => {
    const placement = placeSelectionToolbar(MID_RECT, size, viewport, 75);

    expect(placement.flipped).toBe(false);
    expect(placement.top).toBe(360);
  });

  it('翻到下方仍然出底时夹回视口内', () => {
    const placement = placeSelectionToolbar(
      { top: 730, bottom: 750, left: 300, right: 400 },
      size,
      viewport,
      700
    );

    // 730 - 8 - 32 = 690 < 700（上沿）→ 翻；750 + 8 = 758 会出底 → 夹回
    expect(placement.flipped).toBe(true);
    expect(placement.top).toBe(viewport.height - size.height - 8);
  });

  it('横向夹在视口边距内（两侧都夹）', () => {
    const left = placeSelectionToolbar({ ...MID_RECT, left: 0, right: 10 }, size, viewport);
    expect(left.left).toBe(8);

    const right = placeSelectionToolbar({ ...MID_RECT, left: 1000, right: 1010 }, size, viewport);
    expect(right.left).toBe(viewport.width - size.width - 8);
  });

  it('视口比条还窄时不产出负坐标', () => {
    const placement = placeSelectionToolbar(MID_RECT, { width: 2000, height: 32 }, viewport);
    expect(placement.left).toBe(8);
  });
});

describe('选区上下文条：动作集', () => {
  it('恰好是 §3.1 上表的行内动作（多一个少一个都要红）', () => {
    expect(SELECTION_ACTION_SPECS.map((spec) => spec.id)).toEqual([
      'format.bold',
      'format.italic',
      'format.strike',
      'format.highlight',
      'format.inline-code',
      'format.insert-link',
      'format.clear-formatting'
    ]);
  });

  it('含 highlight —— `==…==` 已于 2026-10-06 进 Markdown 模型（此前这里是一条反面断言）', () => {
    expect(SELECTION_ACTION_SPECS.map((spec) => spec.id)).toContain('format.highlight');
  });

  it('反面：链接**只有一项**，不拆成 link + wikilink —— 写法由设置项决定，不该两个按钮打架', () => {
    const ids = SELECTION_ACTION_SPECS.map((spec) => spec.id);
    expect(ids).toContain('format.insert-link');
    expect(ids).not.toContain('format.wikilink');
  });

  it('链接与清除格式不参与激活态，其余五项各对应一个行内标记', () => {
    const byId = new Map(SELECTION_ACTION_SPECS.map((spec) => [spec.id, spec.format]));

    expect(byId.get('format.bold')).toBe('strong');
    expect(byId.get('format.italic')).toBe('emphasis');
    expect(byId.get('format.strike')).toBe('strike');
    expect(byId.get('format.highlight')).toBe('highlight');
    expect(byId.get('format.inline-code')).toBe('inline-code');
    // 「插入链接」与「清除格式」都没有「当前是它」这一态
    expect(byId.get('format.insert-link')).toBeUndefined();
    expect(byId.get('format.clear-formatting')).toBeUndefined();
  });
});

describe('选区上下文条：渲染与交互', () => {
  let container: HTMLDivElement;
  let root: Root;

  let onAction: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;

  const bar = () => container.querySelector<HTMLElement>('[data-selection-toolbar]');

  const button = (action: string) =>
    container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);

  const actions = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-selection-toolbar] [data-action]')).map(
      (el) => el.getAttribute('data-action')
    );

  const render = async (anchor: SelectionAnchor | null, list: SelectionAction[]) => {
    await act(async () => {
      root.render(
        React.createElement(SelectionToolbar, {
          anchor,
          actions: list,
          label: t('editor.selectionToolbar.label'),
          onAction,
          onDismiss
        })
      );
    });
  };

  const click = async (selector: string) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const pointerDownOn = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
  };

  /**
   * 按一次左键，并把浏览器那条「按下按钮就抢焦点」的默认动作补上。
   * happy-dom 不实现默认动作 —— 直接断言「焦点没变」在那里恒真，等于没测。
   */
  const pressLeftButton = async (selector: string) => {
    const el = container.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`没有找到 ${selector}`);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      el.dispatchEvent(down);
      if (!down.defaultPrevented) el.focus();
    });
    return down;
  };

  beforeEach(() => {
    onAction = vi.fn();
    onDismiss = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localeManager.setLocale('en-US');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // 单例：本文件改过 locale，不还原会漏给同进程后面的用例
    localeManager.setLocale('en-US');
    vi.restoreAllMocks();
  });

  it('有非空选区时出现，data-action 覆盖全部行内动作', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    expect(bar()).not.toBeNull();
    expect(actions()).toEqual([
      'format.bold',
      'format.italic',
      'format.strike',
      'format.highlight',
      'format.inline-code',
      'format.insert-link',
      'format.clear-formatting'
    ]);
  });

  it('反面：没有选区（anchor 为 null）时整条不渲染', async () => {
    await render(null, actionsFromSpecs());

    // 光标移动不该弹出工具条 —— 这是「空选区」在数据层的样子
    expect(bar()).toBeNull();
    expect(actions()).toEqual([]);
  });

  it('选区在可用区域顶部时翻到下方', async () => {
    await render(TOP_ANCHOR, actionsFromSpecs());

    const el = bar()!;
    expect(el.hasAttribute('data-flipped')).toBe(true);
    // 判据钉在几何上：条的 top 要在选区 bottom 之下
    expect(parseFloat(el.style.top)).toBeGreaterThan(TOP_RECT.bottom);
  });

  it('反面：选区在中段时留在上方', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    const el = bar()!;
    expect(el.hasAttribute('data-flipped')).toBe(false);
    expect(parseFloat(el.style.top)).toBeLessThan(MID_RECT.top);
  });

  it('点条外部关闭，点条内部不关闭', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    // 内部：按下不该关 —— 否则条先被卸掉，按钮的 click 永远到不了
    await pointerDownOn(button('format.bold')!);
    expect(onDismiss).not.toHaveBeenCalled();
    // 连条上的空白处也算内部
    await pointerDownOn(bar()!);
    expect(onDismiss).not.toHaveBeenCalled();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await pointerDownOn(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it('按钮的动作接到 onAction 上，传的是命令 id', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    await click('[data-action="format.inline-code"]');
    expect(onAction).toHaveBeenCalledWith('format.inline-code');
  });

  it('原子选区（代码块 / 行内代码 / 公式里）时格式按钮禁用', async () => {
    await render(MID_ANCHOR, actionsFromSpecs(true));

    for (const action of actions()) {
      const el = button(action!)!;
      expect(el.disabled, `${action} 该被禁用`).toBe(true);
      expect(el.getAttribute('aria-disabled'), `${action} 该带 aria-disabled`).toBe('true');
    }
  });

  it('反面：普通选区时一个按钮都不禁用', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    for (const action of actions()) {
      const el = button(action!)!;
      expect(el.disabled, `${action} 不该被禁用`).toBe(false);
      // 只断言「不宣布成禁用」—— 钉死某种写法只会让将来正当的改动变红
      expect(el.getAttribute('aria-disabled'), `${action} 不该宣布成禁用`).not.toBe('true');
    }
  });

  it('激活态：视觉类名与 aria-pressed 出自同一个布尔', async () => {
    await render(MID_ANCHOR, actionsFromSpecs(false, ['strong', 'inline-code']));

    const active = button('format.bold')!;
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(active.className).toContain('nexus-toolbar-button-on');

    const inactive = button('format.italic')!;
    expect(inactive.getAttribute('aria-pressed')).toBe('false');
    expect(inactive.className).not.toContain('nexus-toolbar-button-on');

    // 不变量：遍历全部按钮，两处永远一致 —— 分成两个表达式时
    // 单看一处都对、合起来矛盾，这种 bug 只看某一个按钮发现不了。
    for (const action of actions()) {
      const el = button(action!)!;
      expect(el.getAttribute('aria-pressed') === 'true').toBe(
        el.className.includes('nexus-toolbar-button-on')
      );
    }
  });

  it('不参与激活态的动作不渲染 aria-pressed', async () => {
    await render(MID_ANCHOR, actionsFromSpecs(false, ['strong']));

    // 「插入链接」与「清除格式」都没有「当前是它」这一态，宣布成「未按下」是在编造一个状态
    expect(button('format.insert-link')!.getAttribute('aria-pressed')).toBeNull();
    expect(button('format.clear-formatting')!.getAttribute('aria-pressed')).toBeNull();
  });

  it('焦点保持：按下左键时拦掉默认行为，按钮不抢编辑器焦点', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    const editor = document.createElement('div');
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const down = await pressLeftButton('[data-action="format.bold"]');
    // 拦在 `mousedown` 上，不是 `click` —— 焦点在按下那一刻就换手了
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);

    editor.remove();
  });

  it('反面：右键不被拦 —— 上下文菜单要用它', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    await act(async () => {
      button('format.bold')!.dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(false);
  });

  it('拦的是 mousedown，不是 click —— 拦了 click 按钮就失灵了', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    const el = button('format.bold')!;
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(clickEvent);
    });

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('条带 role=toolbar 与可访问名字', async () => {
    await render(MID_ANCHOR, actionsFromSpecs());

    const el = bar()!;
    expect(el.getAttribute('role')).toBe('toolbar');
    expect(el.getAttribute('aria-label')).toBe(t('editor.selectionToolbar.label'));
  });
});
