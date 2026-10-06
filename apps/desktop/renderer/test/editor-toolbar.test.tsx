// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@nexus/i18n';
import type { BlockFormatState } from '@nexus/editor';
import { EditorToolbar } from '../src/editor/EditorToolbar.js';
import type { ContextMenuItem } from '../src/components/ContextMenu.js';
import { CodeIcon, EyeIcon } from '../src/components/editor-icons.js';
import { localeManager } from '../src/platform.js';

/**
 * 编辑器常驻工具栏的**渲染契约**（2026-10-03，块级动作 2026-10-04，标题拆按钮 2026-10-06）。
 *
 * 这里钉六件事，都是组件里的分支、真机用例覆盖不到的：
 *
 * 1. **动作集恰好是那十六个**（两个文档动作 + 模式切换 + 十一个块级动作 + 查找 + 更多），
 *    且**一个行内格式按钮都没有**。正反两面都要断言 —— 只断言「有 undo」对
 *    「顺手塞了个加粗按钮」同样成立。
 * 2. **块级动作与行内动作的分界线是「无选区时还有没有意义」**：块级作用于光标所在行，
 *    行内在 `createInlineFormatTransaction` 里对空选区返回 `null`（常驻＝死按钮）。
 *    所以「有 `format.quote`」与「没有 `bold`」要**同时**断言，否则这条线守不住。
 * 3. **surface 切换按钮的图标与 `aria-pressed` 出自同一个表达式**（判据 36）。
 *    分成两个表达式时，两处各自都对、合起来矛盾，这种 bug 单看一处永远发现不了。
 * 4. **块级按钮的按下态与禁用从 `formatState` 派生**，与「格式」菜单的 ✓ / 灰同源。
 * 5. **「更多」那个下拉的开关**：点条目要执行并关闭；点锚点按钮是「关」不是「关了又开」
 *    （`ContextMenu` 的 `anchorRef` 就是为这条加的）。
 * 6. **只读降级**（P0-5）：写动作（含块级）禁用、读 / 视图动作保留，且整条栏**仍然渲染**
 *    —— 蓝图 §19 要的是「降级」，不是「隐藏」。
 *
 * 焦点保持（P0-4）也在这里：默认行为要拦在 `mousedown` 上，见 `pressLeftButton` 的注释
 * —— 这条在 happy-dom 里必须**补上浏览器那条默认动作**才测得出东西。
 *
 * **判据 ③（外壳空白处点击能落到正文）不在这里测。** 那是 OpenKnowledge 的**浮层**
 * 形态才有的问题（所以它需要 `editor-toolbar-overlap.ts`）。Nexus 这一栏是正常流的
 * 一行，不覆盖正文，那个失效模式不存在 —— 断言一个不可能发生的事没有意义。
 *
 * `apps/desktop/test/**` 与 `renderer/test/**` 都不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string): string => translate(localeManager.locale, key);

/**
 * 工具栏的全部动作，按 DOM 顺序。
 *
 * 中间十一个块级动作**手抄一份而不是从 `BLOCK_FORMAT_TOOLBAR` 推** —— 用推导写的话，
 * 表里少一项、顺序变了，这里都跟着变，等于没断言。这一条要的正是「表变了就得有人来看一眼」。
 */
const ACTIONS = [
  'undo',
  'redo',
  'toggle-surface',
  'format.paragraph',
  'format.heading-1',
  'format.heading-2',
  'format.heading-3',
  'format.heading-4',
  'format.heading-5',
  'format.heading-6',
  'format.quote',
  'format.bullet-list',
  'format.ordered-list',
  'format.task-list',
  'find',
  'more'
] as const;

describe('编辑器常驻工具栏', () => {
  let container: HTMLDivElement;
  let root: Root;

  let onUndo: ReturnType<typeof vi.fn>;
  let onRedo: ReturnType<typeof vi.fn>;
  let onToggleSurface: ReturnType<typeof vi.fn>;
  let onFind: ReturnType<typeof vi.fn>;
  let onReplace: ReturnType<typeof vi.fn>;
  let onBlockFormat: ReturnType<typeof vi.fn>;

  /** 一个可改型、无引用、不在代码块里的普通块 —— 用例只覆盖自己关心的那几个字段。 */
  const blockState = (over: Partial<BlockFormatState> = {}): BlockFormatState => ({
    leaf: null,
    quoted: false,
    editable: true,
    inCodeBlock: false,
    ...over
  });

  /** 工具栏里的动作，按 DOM 顺序。 */
  const actions = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.nexus-editor-toolbar [data-action]')).map(
      (el) => el.getAttribute('data-action')
    );

  const button = (action: string) =>
    container.querySelector<HTMLButtonElement>(`.nexus-editor-toolbar [data-action="${action}"]`);

  const click = async (selector: string) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  /** 在工具栏**外面**按一下（捕获阶段的 `pointerdown` 才是菜单的关闭来源）。 */
  const pointerDownOutside = async () => {
    await act(async () => {
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      outside.remove();
    });
  };

  const pointerDownOn = async (selector: string) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
  };

  /**
   * 按一次**左键**，并把浏览器那条「按下按钮就抢焦点」的默认动作补上。
   *
   * happy-dom 不实现鼠标事件的默认动作 —— 直接断言「焦点没变」在那里恒真，等于没测。
   * 所以这里自己演一遍：`preventDefault` 没被调用就把焦点给按钮。这恰好就是被测的契约
   * （焦点保持靠的就是取消这条默认行为），而反向用例（右键）证明这个模拟是活的。
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

  const menu = () => container.querySelector('.nexus-context-menu');

  /**
   * 把一枚图标渲染成字符串。
   *
   * 断言「按钮里画的确实是这一枚」时**不要手抄 path 数据** —— 抄一份等于把图标钉死，
   * 以后正当改形状会红，而真正要守的是「图标跟着 `surfaceKind` 走」这个映射。
   */
  const iconMarkup = (icon: React.ReactElement) => {
    const host = document.createElement('div');
    const probe = createRoot(host);
    act(() => {
      probe.render(icon);
    });
    const html = host.querySelector('svg')?.innerHTML ?? null;
    act(() => probe.unmount());
    return html;
  };

  const render = async (
    kind: 'source' | 'visual' = 'source',
    readOnly = false,
    state: BlockFormatState = blockState()
  ) => {
    const moreItems: ContextMenuItem[] = [
      { id: 'replace', label: 'Replace', onSelect: onReplace }
    ];
    await act(async () => {
      root.render(
        React.createElement(EditorToolbar, {
          surfaceKind: kind,
          readOnly,
          formatState: state,
          onUndo,
          onRedo,
          onToggleSurface,
          onFind,
          onBlockFormat,
          moreItems
        })
      );
    });
  };

  beforeEach(() => {
    onUndo = vi.fn();
    onRedo = vi.fn();
    onToggleSurface = vi.fn();
    onFind = vi.fn();
    onReplace = vi.fn();
    onBlockFormat = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 语言钉死，断言文案才不依赖「默认是哪个」
    localeManager.setLocale('en-US');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // 单例：本文件改过 locale，不还原会漏给同进程后面的用例
    localeManager.setLocale('en-US');
    vi.restoreAllMocks();
  });

  it('动作集恰好是这十六个', async () => {
    await render();
    expect(actions()).toEqual([...ACTIONS]);
  });

  it('块级动作在、行内动作不在 —— 分界线是「无选区时还有没有意义」', async () => {
    await render();

    // 正面：块级动作无选区时作用于**光标所在行**，常驻永远有效。
    for (const action of [
      'format.paragraph',
      'format.heading-1',
      'format.heading-2',
      'format.heading-3',
      'format.heading-4',
      'format.heading-5',
      'format.heading-6',
      'format.quote',
      'format.bullet-list',
      'format.ordered-list',
      'format.task-list'
    ]) {
      expect(container.querySelector(`[data-action="${action}"]`), action).not.toBeNull();
    }

    // 反面：行内动作对空选区返回 `null`（`inline-format.ts` 的短路），常驻＝一排死按钮。
    // 它们归选区上下文条（有非空选区才浮出）。
    for (const action of [
      'bold',
      'italic',
      'strike',
      'inline-code',
      'link',
      'wikilink',
      'clear-formatting',
      'highlight'
    ]) {
      expect(container.querySelector(`[data-action="${action}"]`), action).toBeNull();
    }

    // 反面：代码块 / 表格 / 分割线**不进常驻栏**（蓝图 `:357`）—— 它们在「格式」菜单里。
    for (const action of ['format.code-block', 'format.table', 'format.divider']) {
      expect(container.querySelector(`[data-action="${action}"]`), action).toBeNull();
    }
  });

  it('块级按钮的按下态与 aria-pressed 出自同一个表达式', async () => {
    await render('source', false, blockState({ leaf: 'bullet-list', quoted: true }));

    for (const [action, pressed] of [
      ['format.bullet-list', true],
      ['format.quote', true],
      ['format.ordered-list', false],
      ['format.task-list', false],
      ['format.paragraph', false],
      ['format.heading-1', false],
      ['format.heading-6', false]
    ] as const) {
      const el = button(action)!;
      expect(el.getAttribute('aria-pressed'), action).toBe(String(pressed));
      // 视觉类与 `aria-pressed` 同源（判据 36）—— 只对其中一个断言的话，
      // 「图标亮了但读屏说没亮」这种不一致照样绿。
      expect(el.className.includes('nexus-toolbar-button-on'), action).toBe(pressed);
    }
  });

  it('标题与正文各亮各的 —— 拆成七枚之后，段落上只有「正文」亮', async () => {
    // 拆按钮之前，这一组要专门把「正文」排除在按下态之外，否则任何段落都会让它亮着。
    // 现在每级各占一格，那条约束换成了「一格只被它自己那一级点亮」。
    await render('source', false, blockState({ leaf: 'paragraph' }));
    expect(button('format.paragraph')!.getAttribute('aria-pressed')).toBe('true');
    expect(button('format.heading-1')!.getAttribute('aria-pressed')).toBe('false');

    await render('source', false, blockState({ leaf: 'heading-4' }));
    expect(button('format.heading-4')!.getAttribute('aria-pressed')).toBe('true');
    expect(button('format.heading-4')!.className.includes('nexus-toolbar-button-on')).toBe(true);
    expect(button('format.heading-3')!.getAttribute('aria-pressed')).toBe('false');
    expect(button('format.paragraph')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('标题按钮：点一下就执行，不开下拉', async () => {
    // 拆按钮之前这里是「点开下拉 → 点条目」两步。现在每级一个按钮，点一下就该走完，
    // 且**不能**再弹出任何菜单 —— 留一个下拉分支在那里等于留一条没人走的路。
    await render('source', false, blockState({ leaf: 'heading-2' }));
    await click('[data-action="format.heading-3"]');

    expect(onBlockFormat).toHaveBeenCalledWith('format.heading-3');
    expect(menu()).toBeNull();
  });

  it('块级按钮：点一下把命令 id 交给回调', async () => {
    await render();
    await click('[data-action="format.quote"]');
    expect(onBlockFormat).toHaveBeenCalledWith('format.quote');
  });

  it('块级按钮：每一枚都配了图标，且没有两枚共用同一张图', async () => {
    await render();

    const markup = new Map<string, string>();
    for (const action of [
      'format.paragraph',
      'format.heading-1',
      'format.heading-2',
      'format.heading-3',
      'format.heading-4',
      'format.heading-5',
      'format.heading-6',
      'format.quote',
      'format.bullet-list',
      'format.ordered-list',
      'format.task-list'
    ]) {
      // 图标表是按 id 索引的 `Record` —— 表里加了一项而没配图标会渲染成空白按钮，
      // 而那在 DOM 上「元素存在、`data-action` 也对」，只查元素存在是查不出来的。
      const svg = button(action)!.querySelector('svg');
      expect(svg, `${action} 没有图标`).not.toBeNull();
      markup.set(action, svg!.innerHTML);
    }
    // 六枚标题共用同一个 `H`、只差右下角的数字，所以这条断言比拆按钮之前更吃紧：
    // 两个数字的 path 写重了（比如 H1 与 H4）会在这里红。
    expect(new Set(markup.values()).size).toBe(markup.size);
  });

  it('块级按钮：落在代码块 / 表格里时整组变灰', async () => {
    // `editable: false` + 不在代码块里 = 表格 / 公式 / `raw`：全禁。
    await render('source', false, blockState({ editable: false }));
    for (const action of [
      'format.paragraph',
      'format.heading-1',
      'format.heading-6',
      'format.quote',
      'format.bullet-list',
      'format.ordered-list',
      'format.task-list'
    ]) {
      expect(button(action)!.disabled, action).toBe(true);
    }

    // 代码块里也一样（只有「代码块」那一项可用，而它不在工具栏上）。
    await render('source', false, blockState({ editable: false, inCodeBlock: true }));
    for (const action of [
      'format.paragraph',
      'format.heading-3',
      'format.quote',
      'format.bullet-list'
    ]) {
      expect(button(action)!.disabled, action).toBe(true);
    }
  });

  it('四个动作各自接到回调上', async () => {
    await render();

    await click('[data-action="undo"]');
    expect(onUndo).toHaveBeenCalledTimes(1);

    await click('[data-action="redo"]');
    expect(onRedo).toHaveBeenCalledTimes(1);

    await click('[data-action="find"]');
    expect(onFind).toHaveBeenCalledTimes(1);

    await click('[data-action="toggle-surface"]');
    expect(onToggleSurface).toHaveBeenCalledTimes(1);
  });

  it('surface 按钮的图标与 aria-pressed 出自同一个表达式', async () => {
    await render('source');
    const sourceButton = button('toggle-surface')!;
    // 画的是**当前**是哪种：source 面画代码尖括号
    expect(sourceButton.getAttribute('aria-pressed')).toBe('false');
    expect(sourceButton.querySelector('svg')!.innerHTML).toBe(iconMarkup(CodeIcon));
    expect(sourceButton.querySelector('svg')!.innerHTML).not.toBe(iconMarkup(EyeIcon));

    await render('visual');
    const visualButton = button('toggle-surface')!;
    expect(visualButton.getAttribute('aria-pressed')).toBe('true');
    expect(visualButton.querySelector('svg')!.innerHTML).toBe(iconMarkup(EyeIcon));
  });

  it('更多：点开有条目、点条目执行并关闭', async () => {
    await render();
    expect(menu()).toBeNull();

    await click('[data-action="more"]');
    expect(menu()).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-context-menu-item]')).map((el) =>
        el.getAttribute('data-context-menu-item')
      )
    ).toEqual(['replace']);
    expect(button('more')!.getAttribute('aria-expanded')).toBe('true');

    await click('[data-context-menu-item="replace"]');
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(button('more')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('更多：点外部关闭', async () => {
    await render();
    await click('[data-action="more"]');
    expect(menu()).not.toBeNull();

    await pointerDownOutside();
    expect(menu()).toBeNull();
  });

  it('更多：再点锚点按钮是「关」，不是「关了又开」', async () => {
    await render();
    await click('[data-action="more"]');
    expect(menu()).not.toBeNull();

    // 锚点内的 pointerdown 不算「点外部」——不排除掉的话菜单先被关掉，
    // 紧接着按钮的 click 又开回来，用户按「关」看到的是「没反应」。
    await pointerDownOn('[data-action="more"]');
    expect(menu()).not.toBeNull();

    await click('[data-action="more"]');
    expect(menu()).toBeNull();
  });

  it('只读：写动作禁用，读 / 视图动作照常可用', async () => {
    await render('source', true);

    // 反面在前：整条栏**仍然渲染**。蓝图 §19 要的是「工具栏控件降级」，不是把它收走。
    expect(container.querySelector('.nexus-editor-toolbar')).not.toBeNull();
    expect(actions()).toEqual([...ACTIONS]);

    // 块级格式是**写**动作 —— 与 undo / redo / more 一起降级。
    for (const action of [
      'undo',
      'redo',
      'format.paragraph',
      'format.heading-1',
      'format.heading-6',
      'format.quote',
      'format.bullet-list',
      'format.ordered-list',
      'format.task-list',
      'more'
    ]) {
      const el = button(action)!;
      expect(el.disabled, `${action} 该被禁用`).toBe(true);
      expect(el.getAttribute('aria-disabled'), `${action} 该带 aria-disabled`).toBe('true');
    }

    // 只读是「不能写」，不是「不能看」：模式切换是视图动作、查找是读动作，
    // 在只读下照样有效。禁掉它们不是降级，是把「看」也一起收了。
    for (const action of ['toggle-surface', 'find']) {
      const el = button(action)!;
      expect(el.disabled, `${action} 不该被禁用`).toBe(false);
      // 只断言「不宣布成禁用」—— `aria-disabled="false"` 与「没有这个属性」等价，
      // 钉死其中一种写法只会让将来正当的改动变红。
      expect(el.getAttribute('aria-disabled'), `${action} 不该宣布成禁用`).not.toBe('true');
    }
  });

  it('只读：禁用按钮的 title 换成原因，不把两个说法叠在一起', async () => {
    await render('source', true);

    // 「撤销。只读文档」读起来像两个动作 —— 灰按钮要直接说**为什么**灰
    // （同 `WorkspaceToolbar` 的 `canDelete` / `deleteHint`）。
    expect(button('undo')!.title).toBe(t('editor.toolbar.readonly'));
    expect(button('redo')!.title).toBe(t('editor.toolbar.readonly'));
    expect(button('format.quote')!.title).toBe(t('editor.toolbar.readonly'));
    expect(button('format.heading-1')!.title).toBe(t('editor.toolbar.readonly'));
    expect(button('more')!.title).toBe(t('editor.toolbar.readonly'));

    // 无障碍名字仍然是**动作**，不是原因 —— 屏幕阅读器读的是「撤销，已禁用」。
    expect(button('undo')!.getAttribute('aria-label')).toBe(t('cmd.undo'));

    // 可用的那两枚照旧说自己是什么
    expect(button('find')!.title).toBe(t('cmd.find'));
  });

  it('反面：非只读且块可改型时一个按钮都不禁用', async () => {
    await render();

    for (const action of ACTIONS) {
      const el = button(action)!;
      expect(el.disabled, `${action} 不该被禁用`).toBe(false);
      expect(el.getAttribute('aria-disabled'), `${action} 不该宣布成禁用`).not.toBe('true');
    }
  });

  it('焦点保持：按下左键时拦掉默认行为，按钮不抢编辑器焦点', async () => {
    await render();

    const editor = document.createElement('div');
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const down = await pressLeftButton('[data-action="undo"]');
    // 拦在 `mousedown` 上，不是 `click` —— 焦点在按下那一刻就换手了。
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);

    editor.remove();
  });

  it('反面：右键不被拦 —— 上下文菜单要用它', async () => {
    await render();

    const el = button('undo')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    await act(async () => {
      el.dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(false);
  });

  it('拦的是 mousedown，不是 click —— 拦了 click 按钮就失灵了', async () => {
    await render();

    const el = button('undo')!;
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(clickEvent);
    });

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
