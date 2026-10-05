// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DICTIONARIES, hasMessage } from '@nexus/i18n';
import { MenuBar, type MenuBarItem } from '../src/MenuBar.js';
import {
  BLOCK_FORMAT_SPECS,
  BLOCK_FORMAT_TOOLBAR,
  blockFormatDropdownItems,
  blockFormatMenuItems,
  findBlockFormatSpec,
  isBlockFormatEntryActive
} from '../src/editor/block-format-specs.js';
import { createSlashCommandHost } from '../src/editor/slash-commands.js';
import { SELECTION_ACTION_SPECS } from '../src/editor/SelectionToolbar.js';
import { EMPTY_BLOCK_FORMAT_STATE } from '@nexus/editor';

/**
 * 「格式」菜单与常驻工具栏：动作表 + 两种投影 + 渲染。
 *
 * 表只有一张（`BLOCK_FORMAT_SPECS`），**四个入口是它的四种排布**：菜单栏（全部 14 项、
 * 按组画线）、`/` 面板（全部 14 项、用触发词匹配）、常驻工具栏（高频子集）、命令注册。
 * 下面每个 describe 各守一种排布，并在两两之间断言「命令 id 逐字相同」。
 *
 * 这里钉四件事：
 *
 * 1. **动作集恰好等于 §3.1 两表之和**（判据 §3.2，正反两面）。只断言「有段落 / 有标题 2」
 *    对「顺手少做几个」同样成立；只断言「没有 highlight」对「顺手塞了个上标」同样成立。
 *    两张表合起来才是工具栏的完整动作集，所以这一条必须同时看 `SELECTION_ACTION_SPECS`
 *    与 `BLOCK_FORMAT_SPECS`。
 * 2. **✓ 与禁用出自 `BlockFormatState`**（判据 36 的同类）：投影函数不自己算状态，
 *    它只读传进来的那一个对象。这里逐态断言，是因为「✓ 亮着、点下去又加一层 `## `」
 *    这种不一致单看事务层或单看菜单都发现不了。
 * 3. **两语文案都在**：菜单项只拿 `labelKey`，缺键时 `t()` 把键名原样返回，
 *    界面上会漏出 `cmd.heading2` 这种噪音 —— 而它不是缺键、不是空值，没有任何东西会报错。
 * 4. **常驻工具栏只铺高频子集**，且**正反两面都断言**：子集里的 id 都真实存在，
 *    代码块 / 表格 / 分割线确实没被铺上去（蓝图 `:357`「不堆叠完整编辑器按钮」）。
 *
 * `apps/desktop/test/**` 与 `renderer/test/**` 都不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string): string => DICTIONARIES['zh-CN']?.[key] ?? key;

/** §3.1 下表的 14 项，逐字抄下来当作对照 —— 从代码里推的话，改错了两边一起错。 */
const EXPECTED_KINDS = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'quote',
  'bullet-list',
  'ordered-list',
  'task-list',
  'code-block',
  'table',
  'horizontal-rule'
];

describe('块级动作表（§3.1 下表）', () => {
  it('恰好是那 14 项，顺序也一致', () => {
    expect(BLOCK_FORMAT_SPECS.map((spec) => spec.kind)).toEqual(EXPECTED_KINDS);
  });

  it('反面：表里没有 `highlight` —— Markdown 模型里没有这个节点', () => {
    expect(BLOCK_FORMAT_SPECS.some((spec) => spec.kind === 'highlight')).toBe(false);
    expect(BLOCK_FORMAT_SPECS.some((spec) => spec.id.includes('highlight'))).toBe(false);
  });

  it('反面：块级表里不重复行内动作（link / wikilink / bold 归选区上下文条）', () => {
    const blockIds = new Set(BLOCK_FORMAT_SPECS.map((spec) => spec.id));
    for (const spec of SELECTION_ACTION_SPECS) {
      expect(blockIds.has(spec.id)).toBe(false);
    }
  });

  it('id 与 kind 各自唯一', () => {
    expect(new Set(BLOCK_FORMAT_SPECS.map((spec) => spec.id)).size).toBe(BLOCK_FORMAT_SPECS.length);
    expect(new Set(BLOCK_FORMAT_SPECS.map((spec) => spec.kind)).size).toBe(BLOCK_FORMAT_SPECS.length);
  });

  it('每一条的文案键在两本词典里都存在', () => {
    for (const spec of BLOCK_FORMAT_SPECS) {
      expect(hasMessage('zh-CN', spec.labelKey), `${spec.id} 缺中文文案`).toBe(true);
      expect(hasMessage('en-US', spec.labelKey), `${spec.id} 缺英文文案`).toBe(true);
    }
  });

  it('两张表合起来覆盖 §3.1 的全部动作（判据 §3.2 的正反两面）', () => {
    const ids = new Set([
      ...SELECTION_ACTION_SPECS.map((spec) => spec.id),
      ...BLOCK_FORMAT_SPECS.map((spec) => spec.id)
    ]);
    // 正面：行内 7 项（bold / italic / strike / highlight / inline-code / insert-link / clear）+ 块级 14 项。
    // 「插入链接」是 link 与 wikilink 两项的合并 —— 写法由设置项决定，不是两个按钮。
    expect(ids.size).toBe(21);
    for (const id of [
      'format.bold',
      'format.italic',
      'format.strike',
      'format.highlight',
      'format.inline-code',
      'format.insert-link',
      'format.clear-formatting',
      ...BLOCK_FORMAT_SPECS.map((spec) => spec.id)
    ]) {
      expect(ids.has(id), `缺了 ${id}`).toBe(true);
    }
  });
});

/**
 * P2-2：`/` 面板里的块级动作与「格式」菜单**指向同一批命令 id**。
 *
 * 这一条才是「同源」的判据本身 —— 上面那张表是唯一出处，两处都是从它投影出来的。
 * 只断言「`/` 面板里也有标题」是不够的：一个自己抄了一份清单的实现同样满足，
 * 而它会在加第五个列表样式时静默漏掉。
 */
describe('`/` 面板与「格式」菜单同源（P2-2）', () => {
  const entries = createSlashCommandHost(t, () => {}).entries();

  const menuItems = () =>
    blockFormatMenuItems(EMPTY_BLOCK_FORMAT_STATE, t, () => {}).filter((item) => !item.separator);

  it('每一项与菜单项指向同一个命令 id，顺序也一致', () => {
    expect(entries.map((entry) => entry.commandId)).toEqual(menuItems().map((item) => item.id));
  });

  it('标签取自命令自己的译文 —— 与菜单项逐字相同，不另写一套说法', () => {
    expect(entries.map((entry) => entry.label)).toEqual(menuItems().map((item) => item.label));
  });

  it('每一项都有触发词，且触发词全局唯一 —— 否则 `/h2` 会一次给出两条', () => {
    const seen = new Set<string>();
    for (const entry of entries) {
      expect(entry.tokens.length, `${entry.commandId} 没有触发词`).toBeGreaterThan(0);
      for (const token of entry.tokens) {
        expect(seen.has(token), `触发词 ${token} 重复`).toBe(false);
        seen.add(token);
      }
    }
  });

  it('触发词一律小写、不含斜杠 —— 面板是拿它跟去掉 `/` 的小写查询串比的', () => {
    for (const entry of entries) {
      for (const token of entry.tokens) {
        expect(token).toBe(token.toLowerCase());
        expect(token).not.toContain('/');
        expect(token.trim()).toBe(token);
      }
    }
  });
});

/**
 * 常驻工具栏上的块级动作（2026-10-04）。**只铺高频子集**，但子集里的每一项都必须是
 * 同一张表里的那一项 —— 「同源」在这里同样是结构性的，不是靠自觉。
 *
 * 这一层要守的是**两个方向**：正向（工具栏引用的 id 都真实存在、`button` 项的标签
 * 不另起一套说法）、反向（代码块 / 表格 / 分割线确实**没**被铺进常驻栏）。
 * 只断言正向的话，「顺手把 14 项全铺上」照样绿 —— 而那正是蓝图 `:357` 反对的。
 */
describe('块级动作表 → 常驻工具栏的投影', () => {
  const ids = BLOCK_FORMAT_TOOLBAR.flatMap((entry) => entry.ids);
  const headingEntry = BLOCK_FORMAT_TOOLBAR.find((entry) => entry.kind === 'menu')!;
  const dropdownIds = (state: Parameters<typeof blockFormatMenuItems>[0]) =>
    blockFormatDropdownItems(headingEntry.ids, state, t, () => {}).filter((item) => !item.separator);
  const menuIds = () =>
    blockFormatMenuItems(EMPTY_BLOCK_FORMAT_STATE, t, () => {})
      .filter((item) => !item.separator)
      .map((item) => item.id);

  it('表里的每个 id 都能在 `BLOCK_FORMAT_SPECS` 里找到', () => {
    for (const id of ids) {
      expect(findBlockFormatSpec(id), `工具栏引用了不存在的 ${id}`).toBeDefined();
    }
  });

  it('`button` 项的 id / labelKey 与它那条 spec 逐字相同', () => {
    for (const entry of BLOCK_FORMAT_TOOLBAR.filter((e) => e.kind === 'button')) {
      const spec = findBlockFormatSpec(entry.ids[0]!)!;
      expect(entry.id, `${entry.id} 的 id 与命令 id 不一致`).toBe(spec.id);
      expect(entry.labelKey, `${entry.id} 另写了一套标签`).toBe(spec.labelKey);
      expect(entry.ids).toEqual([spec.id]);
    }
  });

  it('没有同一个动作被铺两次', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('恰好是「标题下拉 + 引用 + 三个列表」，覆盖 10 项', () => {
    expect(BLOCK_FORMAT_TOOLBAR.map((entry) => entry.kind)).toEqual([
      'menu',
      'button',
      'button',
      'button',
      'button'
    ]);
    expect(ids).toEqual([
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
    ]);
  });

  it('反面：代码块 / 表格 / 分割线**不在**常驻栏（蓝图 `:357`）', () => {
    for (const id of ['format.code-block', 'format.table', 'format.divider']) {
      expect(ids, `${id} 不该常驻`).not.toContain(id);
    }
  });

  it('每一项的标签键在两本词典里都存在', () => {
    for (const entry of BLOCK_FORMAT_TOOLBAR) {
      expect(hasMessage('zh-CN', entry.labelKey), `${entry.id} 缺中文文案`).toBe(true);
      expect(hasMessage('en-US', entry.labelKey), `${entry.id} 缺英文文案`).toBe(true);
    }
  });

  it('标题下拉的命令 id 与「格式」菜单的前 7 项逐字相同（同源）', () => {
    expect(dropdownIds(EMPTY_BLOCK_FORMAT_STATE).map((item) => item.id)).toEqual(menuIds().slice(0, 7));
  });

  it('标题下拉的标签与菜单项逐字相同', () => {
    expect(dropdownIds(EMPTY_BLOCK_FORMAT_STATE).map((item) => item.label)).toEqual(
      blockFormatMenuItems(EMPTY_BLOCK_FORMAT_STATE, t, () => {})
        .filter((item) => !item.separator)
        .slice(0, 7)
        .map((item) => item.label)
    );
  });

  it('标题下拉的分组线与菜单一致：正文与标题之间恰好一条，且在第二位', () => {
    const list = blockFormatDropdownItems(headingEntry.ids, EMPTY_BLOCK_FORMAT_STATE, t, () => {});
    expect(list.filter((item) => item.separator)).toHaveLength(1);
    expect(list[1]?.separator).toBe(true);
    expect(list[0]?.separator).toBeUndefined();
    expect(list.at(-1)?.separator).toBeUndefined();
  });

  it('下拉里的 ✓ 与菜单同源，且只有一个', () => {
    const state = { leaf: 'heading-3' as const, quoted: false, editable: true, inCodeBlock: false };
    expect(dropdownIds(state).filter((item) => item.active).map((item) => item.id)).toEqual([
      'format.heading-3'
    ]);
  });

  it('标题按钮**不被「正文」点亮** —— 否则它在任何段落上都亮着，等于没有', () => {
    expect(headingEntry.activeIds).toBeDefined();
    expect(headingEntry.activeIds).not.toContain('format.paragraph');
    // 子集关系：`activeIds` 只能从 `ids` 里挑，不能凭空写一个不存在的命令
    for (const id of headingEntry.activeIds!) expect(headingEntry.ids).toContain(id);

    const state = (leaf: string | null) => ({
      leaf: leaf as never,
      quoted: false,
      editable: true,
      inCodeBlock: false
    });
    expect(isBlockFormatEntryActive(headingEntry, state('paragraph')), '正文上不该亮').toBe(false);
    expect(isBlockFormatEntryActive(headingEntry, state('heading-2')), '标题 2 上该亮').toBe(true);
    expect(isBlockFormatEntryActive(headingEntry, state(null)), '类型不一致时不该亮').toBe(false);
  });

  it('没有 `activeIds` 的条目按全部 `ids` 判 —— 引用 / 列表那四个', () => {
    const state = { leaf: null, quoted: true, editable: true, inCodeBlock: false };
    for (const entry of BLOCK_FORMAT_TOOLBAR.filter((e) => e.kind === 'button')) {
      expect(entry.activeIds, `${entry.id} 不该有 activeIds`).toBeUndefined();
      expect(isBlockFormatEntryActive(entry, state), entry.id).toBe(entry.id === 'format.quote');
    }
  });
});

describe('块级动作表 → 菜单项的投影', () => {
  const run = vi.fn();
  const items = (state: Parameters<typeof blockFormatMenuItems>[0]) =>
    blockFormatMenuItems(state, t, run);

  const labelsOf = (list: MenuBarItem[]) => list.filter((item) => !item.separator);

  it('分组之间插分隔线，组内不插', () => {
    const list = items(EMPTY_BLOCK_FORMAT_STATE);
    // 5 组（正文 / 标题 / 引用 / 列表 / 块）⇒ 4 条分隔线。
    expect(list.filter((item) => item.separator)).toHaveLength(4);
    expect(labelsOf(list)).toHaveLength(BLOCK_FORMAT_SPECS.length);
    // 分隔线不出现在头尾。
    expect(list[0]?.separator).toBeUndefined();
    expect(list.at(-1)?.separator).toBeUndefined();
  });

  it('`leaf` 决定叶块类型那一项的 ✓，且**只有一个**', () => {
    const list = labelsOf(items({ leaf: 'heading-2', quoted: false, editable: true, inCodeBlock: false }));
    expect(list.filter((item) => item.active).map((item) => item.label)).toEqual(['标题 2']);
  });

  it('引用与叶块类型**同时**亮：`> ## 标题` 上两项都该 ✓', () => {
    const list = labelsOf(items({ leaf: 'heading-2', quoted: true, editable: true, inCodeBlock: false }));
    expect(list.filter((item) => item.active).map((item) => item.label)).toEqual(['标题 2', '引用']);
  });

  it('`leaf` 为 `null`（多行类型不一致）时一个 ✓ 都不亮', () => {
    const list = labelsOf(items({ leaf: null, quoted: false, editable: true, inCodeBlock: false }));
    expect(list.filter((item) => item.active)).toHaveLength(0);
  });

  it('代码块里：✓ 落在「代码块」上，其余全禁用 —— 那一项在那里是拆围栏', () => {
    const list = labelsOf(items({ leaf: null, quoted: false, editable: false, inCodeBlock: true }));
    expect(list.filter((item) => item.active).map((item) => item.label)).toEqual(['代码块']);
    expect(list.filter((item) => !item.disabled).map((item) => item.label)).toEqual(['代码块']);
  });

  it('表格 / 公式 / raw 里：连「代码块」也禁用（包进去会把那些结构退化成字面文本）', () => {
    const list = labelsOf(items({ leaf: null, quoted: false, editable: false, inCodeBlock: false }));
    expect(list.filter((item) => !item.disabled)).toHaveLength(0);
  });

  it('点一项执行的是**它自己那条命令 id**，不是「当前那一项」', () => {
    run.mockClear();
    const list = labelsOf(items(EMPTY_BLOCK_FORMAT_STATE));
    list[1]?.onSelect?.();
    expect(run).toHaveBeenCalledWith('format.heading-1');
    list.at(-1)?.onSelect?.();
    expect(run).toHaveBeenLastCalledWith('format.divider');
  });
});

describe('「格式」菜单的渲染', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (items: MenuBarItem[]) => {
    act(() => {
      root.render(<MenuBar menus={[{ id: 'format', label: '格式', items }]} />);
    });
  };

  const openMenu = () => {
    act(() => {
      container
        .querySelector<HTMLButtonElement>('.nexus-menu-bar-button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('打开后列出全部动作，并按组画出分隔线', () => {
    render(blockFormatMenuItems(EMPTY_BLOCK_FORMAT_STATE, t, () => {}));
    openMenu();

    const labels = Array.from(
      container.querySelectorAll<HTMLElement>('.nexus-menu-item .nexus-menu-item-label')
    ).map((el) => el.textContent);
    expect(labels).toEqual(BLOCK_FORMAT_SPECS.map((spec) => t(spec.labelKey)));
    expect(container.querySelectorAll('.nexus-menu-separator')).toHaveLength(4);
  });

  it('当前块类型那一项带 ✓ 前缀，切到别的位置就没有', () => {
    render(
      blockFormatMenuItems({ leaf: 'quote', quoted: true, editable: true, inCodeBlock: false }, t, () => {})
    );
    openMenu();

    const marked = Array.from(
      container.querySelectorAll<HTMLElement>('.nexus-menu-item .nexus-menu-item-label')
    )
      .filter((el) => el.textContent?.startsWith('✓'))
      .map((el) => el.textContent?.replace('✓', '').trim());
    expect(marked).toEqual(['引用']);
  });

  it('禁用的项真的不可点 —— 表格里整组灰掉', () => {
    render(
      blockFormatMenuItems(
        { leaf: null, quoted: false, editable: false, inCodeBlock: false },
        t,
        () => {}
      )
    );
    openMenu();
    expect(container.querySelectorAll('.nexus-menu-item:not([disabled])')).toHaveLength(0);
  });
});
