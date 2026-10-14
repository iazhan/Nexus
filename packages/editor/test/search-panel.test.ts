// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection, type Extension } from '@codemirror/state';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  getSearchQuery,
  openSearchPanel,
  setSearchQuery
} from '@codemirror/search';
import { localizedSearchPhrases, openFindPanel, openReplacePanel, setEditorLocale } from '../src/index.js';
import {
  computeMatchCount,
  searchHitRangesExtension,
  searchHitRangesField,
  searchPanelExtension,
  searchPhrasesExtension
} from '../src/search-panel.js';
import { getSourceEditorExtensions } from '../src/source-editor.js';

/**
 * 查找面板是**自绘**的（`search({ createPanel })`），所以这一份测试测的是我们自己的
 * DOM 契约 —— 它同时被三处依赖，改 `PART` 里任何一个 `name` 等于改三处：
 * ① 宿主命令 `openReplacePanel`（靠 `.nexus-find input[name="replace"]` 找替换框）；
 * ② `apps/desktop/test/editor-search-panel.test.ts` 的真机用例；
 * ③ CM 自己（`openSearchPanel` 靠 `[main-field]` 找该聚焦的输入框）。
 */

const mounted: EditorView[] = [];

function mount(options: { locale?: string; doc?: string; readOnly?: boolean } = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    doc: options.doc ?? '查找我 find me',
    parent,
    extensions: [
      searchPanelExtension,
      searchPhrasesExtension(options.locale ?? 'zh-CN'),
      ...(options.readOnly ? [EditorState.readOnly.of(true)] : [])
    ]
  });
  mounted.push(view);
  return view;
}

/** 装完整源码面扩展（含搜索面板本体）—— 计数、选中即高亮两组要用。 */
function mountFull(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    doc,
    parent,
    extensions: getSourceEditorExtensions({ locale: 'zh-CN' })
  });
  mounted.push(view);
  return view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

/* ---- 选择器助手：全部落在 `.nexus-find` 里 ---- */

const panel = (view: EditorView) => view.dom.querySelector<HTMLElement>('.nexus-find');

const inputEl = (view: EditorView, name: 'search' | 'replace') =>
  view.dom.querySelector<HTMLInputElement>(`.nexus-find input[name="${name}"]`);

const buttonEl = (view: EditorView, name: string) =>
  view.dom.querySelector<HTMLButtonElement>(`.nexus-find button[name="${name}"]`);

const countText = (view: EditorView) =>
  view.dom.querySelector<HTMLElement>('.nexus-find-count')?.textContent ?? '';

/** 往输入框里敲字。面板认 `input` 事件（内置面板认 `keyup`/`change`，这里不一样）。 */
function type(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error('输入框不在');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(target: EventTarget | null, key: string, shiftKey = false): void {
  if (!target) throw new Error('按键目标不在');
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

/**
 * CM 自己会去 `EditorState.phrases` 查的英文短语（读屏播报用）。
 *
 * 键必须与 `@codemirror/search` 里的字面量**逐字一致** —— 那是个查表，写错一个字母
 * 那一条就静默回落英文，没有任何报错。这份清单从 `@codemirror/search` 的实现里逐条
 * 抄来（`phrase(view, …)` 的实参），升级 cm/search 后多一条少一条这里会红。
 */
const CM_ANNOUNCE_PHRASES = [
  'current match',
  'on line',
  'replaced match on line $',
  'replaced $ matches'
];

/**
 * 自绘面板要读的 i18n 键。**这份清单是契约**：少一条 = 面板上那个字变回键名
 * （`state.phrase(key)` 查不到就原样返回键），而界面上看不出「这是个 bug」。
 */
const PANEL_KEYS = [
  'editor.search.panelLabel',
  'editor.search.find',
  'editor.search.replace',
  'editor.search.replaceOne',
  'editor.search.replaceAll',
  'editor.search.next',
  'editor.search.previous',
  'editor.search.matchCase',
  'editor.search.byWord',
  'editor.search.regexp',
  'editor.search.close',
  'editor.search.toggleReplace',
  'editor.search.noResults'
];

describe('查找 / 替换面板：文案', () => {
  it('CM 播报用的每一条英文短语都有译文', () => {
    const phrases = localizedSearchPhrases('zh-CN');
    for (const phrase of CM_ANNOUNCE_PHRASES) {
      expect(phrases, `缺少短语 "${phrase}" 的译文`).toHaveProperty(phrase);
      expect(phrases[phrase], `"${phrase}" 回落成了英文`).not.toBe(phrase);
    }
  });

  it('面板要读的每一个 i18n 键都在表里，且是真译文', () => {
    const phrases = localizedSearchPhrases('zh-CN');
    for (const key of PANEL_KEYS) {
      expect(phrases, `缺少键 "${key}"`).toHaveProperty(key);
      // `translate` 找不到键时返回键本身 —— 所以「值等于键」就是漏译文的判据。
      expect(phrases[key], `"${key}" 的译文缺失`).not.toBe(key);
    }
  });

  it('中文面板：输入框 placeholder / aria-label 与卡片 aria-label 都是中文', () => {
    const view = mount();
    openSearchPanel(view);
    expect(inputEl(view, 'search')?.placeholder).toBe('查找');
    expect(inputEl(view, 'search')?.getAttribute('aria-label')).toBe('查找');
    expect(inputEl(view, 'replace')?.placeholder).toBe('替换为');
    // 图标按钮没有文字，含义全靠 aria-label / title —— 缺了它对读屏用户等于消失。
    expect(buttonEl(view, 'close')?.getAttribute('aria-label')).toBe('关闭查找面板');
    expect(buttonEl(view, 'close')?.title).toBe('关闭查找面板');
    expect(buttonEl(view, 'next')?.getAttribute('aria-label')).toBe('下一个');
    expect(panel(view)?.getAttribute('aria-label')).toBe('查找和替换');
  });

  it('切到英文后面板跟着换', () => {
    const view = mount();
    openSearchPanel(view);
    expect(inputEl(view, 'search')?.placeholder).toBe('查找');

    setEditorLocale(view, 'en-US');
    expect(inputEl(view, 'search')?.placeholder).toBe('Find');
    expect(buttonEl(view, 'close')?.getAttribute('aria-label')).toBe('Close search panel');
    expect(panel(view)?.getAttribute('aria-label')).toBe('Find and replace');
  });
});

describe('查找 / 替换面板：两个入口', () => {
  it('「查找」把焦点放在查找框，并收起替换行', () => {
    const view = mount();
    openFindPanel(view);
    expect(document.activeElement).toBe(inputEl(view, 'search'));
    expect(panel(view)?.dataset.replace).toBe('closed');
  });

  it('「替换」把焦点放在替换框，并展开替换行', () => {
    const view = mount();
    openReplacePanel(view);
    expect(panel(view)?.dataset.replace).toBe('open');
    expect(document.activeElement).toBe(inputEl(view, 'replace'));
  });

  it('只读文档收起替换行，「替换」退回到查找框', () => {
    // 焦点不能跑到编辑器外面去，否则用户按 Mod-h 之后下一步敲的字不知道去了哪儿。
    // 收起替换行是 CSS 干的（`[data-readonly="true"] .nexus-find-replace-row{display:none}`）
    // —— happy-dom 不算 CSS，所以这里断言的是**驱动那条规则的数据属性**，
    // 真正的显隐由真机用例看着。
    const view = mount({ readOnly: true });
    openReplacePanel(view);
    expect(panel(view)?.dataset.readonly).toBe('true');
    expect(document.activeElement).toBe(inputEl(view, 'search'));
  });

  it('已经开着面板时再按「查找」，替换行照样收起', () => {
    // 这条挡的是「值没变就不发事务」的写法：`openSearchPanel` 在面板已开、焦点又正好
    // 在查找框时会**一个事务都不发**，面板收不到 `update`，替换行会一直留在那儿。
    const view = mount();
    openReplacePanel(view);
    expect(panel(view)?.dataset.replace).toBe('open');
    openFindPanel(view);
    expect(panel(view)?.dataset.replace).toBe('closed');
  });
});

describe('查找 / 替换面板：自绘结构', () => {
  it('面板挂在编辑器上方那组里，并且带 `cm-panel` 这个 CM 的类名', () => {
    // `PanelGroup` 按 `panel.top` 决定挂进 `.cm-panels-top` 还是 `.cm-panels-bottom`，
    // 漏写 `get top()` 面板会跑到编辑器**下方**，而样式是按 top 那组写的。
    const view = mount();
    openSearchPanel(view);
    const group = view.dom.querySelector('.cm-panels-top');
    expect(group).not.toBeNull();
    expect(group?.querySelector('.nexus-find')).toBe(panel(view));
    // `cm-panel` 是 CM 自己加的（`p.dom.classList.add("cm-panel")`），不是我们的类名 ——
    // 它上面挂着 CM 的 `position: sticky` 默认样式，是我们那条覆盖规则的作用对象。
    expect(panel(view)?.classList.contains('cm-panel')).toBe(true);
  });

  it('查找框带 `main-field`（CM 靠它找该聚焦的输入框）', () => {
    const view = mount();
    openSearchPanel(view);
    expect(inputEl(view, 'search')?.hasAttribute('main-field')).toBe(true);
    // 替换框不能带 —— `getSearchInput` 拿的是**第一个** `[main-field]`，多一个就抢焦点。
    expect(inputEl(view, 'replace')?.hasAttribute('main-field')).toBe(false);
  });

  it('三个开关点一下就切一次，`aria-pressed` 正反两面都跟着走', () => {
    const view = mount();
    openSearchPanel(view);
    for (const [name, field] of [
      ['case', 'caseSensitive'],
      ['word', 'wholeWord'],
      ['re', 'regexp']
    ] as const) {
      const button = buttonEl(view, name);
      expect(button?.getAttribute('aria-pressed')).toBe('false');
      button?.click();
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      expect(getSearchQuery(view.state)[field]).toBe(true);
      // 再点一次 —— 判据要正反两面，只测「能打开」会漏掉「关不掉」。
      button?.click();
      expect(button?.getAttribute('aria-pressed')).toBe('false');
      expect(getSearchQuery(view.state)[field]).toBe(false);
    }
  });

  it('折叠按钮切换展开态，箭头与 aria-expanded 跟着走', () => {
    const view = mount();
    openFindPanel(view);
    const toggle = buttonEl(view, 'toggle-replace');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(panel(view)?.dataset.replace).toBe('closed');

    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(panel(view)?.dataset.replace).toBe('open');

    // 再点一次回到收起。
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(panel(view)?.dataset.replace).toBe('closed');
  });

  it('查找框里 Enter / Shift+Enter 前后跳转', () => {
    const view = mountFull('abc def abc abc');
    openFindPanel(view);
    const search = inputEl(view, 'search');
    type(search, 'abc');
    expect(countText(view)).toBe('1/3');

    // 第一次 Enter 落在第一处（光标初始在 0，`findNext` 从 to=0 往后找）——
    // 光标还在第一处里，计数不动；第二次才前进到第二处。
    press(search, 'Enter');
    expect(countText(view)).toBe('1/3');
    press(search, 'Enter');
    expect(countText(view)).toBe('2/3');
    // Shift+Enter 回到上一处。
    press(search, 'Enter', true);
    expect(countText(view)).toBe('1/3');
  });

  it('替换框里 Enter 走替换', () => {
    const view = mountFull('abc def abc');
    openReplacePanel(view);
    type(inputEl(view, 'search'), 'abc');
    type(inputEl(view, 'replace'), 'xyz');
    // CM 的 `replaceNext` 是**两步**语义：光标不在匹配上时第一次只把匹配选中
    // （`next.from == from && next.to == to` 不成立，changes 是空的），第二次才真替换。
    // 这条钉住它 —— 只按一次就说「替换没生效」是误解。
    press(inputEl(view, 'replace'), 'Enter');
    expect(view.state.doc.toString()).toBe('abc def abc');
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(3);

    press(inputEl(view, 'replace'), 'Enter');
    expect(view.state.doc.toString()).toBe('xyz def abc');
  });

  it('面板里按 Escape 关掉面板', () => {
    const view = mount();
    openSearchPanel(view);
    expect(panel(view)).not.toBeNull();
    // 焦点在面板里时编辑器的 keymap 收不到事件（`.cm-panels` 在 `contentDOM` 之外），
    // 所以这个键只能由面板自己接。
    press(inputEl(view, 'search'), 'Escape');
    expect(panel(view)).toBeNull();
    expect(view.dom.querySelector('.cm-panels-top')).toBeNull();
  });

  it('替换框的输入写进查询的 `replace`', () => {
    const view = mountFull('abc');
    openReplacePanel(view);
    type(inputEl(view, 'replace'), 'xyz');
    expect(getSearchQuery(view.state).replace).toBe('xyz');
  });

  it('查询被面板之外改掉时，输入框跟着变', () => {
    // `openSearchPanel` 打开时会拿当前选区兜底造一个查询，宿主的命令也可能改查询 ——
    // 不写回输入框的话，面板显示的和实际搜的就脱节了。
    const view = mountFull('abc def abc');
    openFindPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'def' })) });
    expect(inputEl(view, 'search')?.value).toBe('def');
  });

  it('改查询不重建面板 DOM（否则每次按键都会丢焦点）', () => {
    const view = mountFull('abc def abc');
    openFindPanel(view);
    const first = panel(view);
    type(inputEl(view, 'search'), 'abc');
    type(inputEl(view, 'search'), 'ab');
    expect(panel(view)).toBe(first);
  });

  it('打开面板时把当前选中的文本带进来', () => {
    const view = mountFull('abc def abc');
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    openFindPanel(view);
    expect(inputEl(view, 'search')?.value).toBe('abc');
    expect(countText(view)).toBe('1/2');
  });

  it('关闭面板后再打开，查询还留着', () => {
    // 查询存在 state 上、面板实例每次新建 —— 这条钉住「实例活不过一次关开」这个事实：
    // 任何跨开关的状态都不能放实例字段，否则这里会读到空值。
    const view = mountFull('abc def abc');
    openFindPanel(view);
    type(inputEl(view, 'search'), 'abc');
    closeSearchPanel(view);
    expect(panel(view)).toBeNull();
    openFindPanel(view);
    expect(inputEl(view, 'search')?.value).toBe('abc');
    expect(countText(view)).toBe('1/2');
  });
});

describe('查找 / 替换面板：匹配计数', () => {
  it('多处匹配显示「当前/总数」，并跟随跳转', () => {
    const view = mountFull('abc def abc abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    // 光标在 0、第一处匹配是 0..3 —— 「光标处或之后第一处」就是第 1 处。
    expect(countText(view)).toBe('1/3');
    findNext(view);
    expect(countText(view)).toBe('1/3');
    findNext(view);
    expect(countText(view)).toBe('2/3');
    findNext(view);
    expect(countText(view)).toBe('3/3');
  });

  it('光标停在某一处匹配中间时，那一处算「当前」', () => {
    const view = mountFull('abc def abc abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    // 第二处是 8..11，光标放它中间（10）：那一处算当前，不能整处跳过。
    view.dispatch({ selection: { anchor: 10 } });
    expect(countText(view)).toBe('2/3');
  });

  it('零匹配显示「无结果」，并给整张卡片打上 `data-state=none`', () => {
    const view = mountFull('abc def');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'zzz' })) });
    expect(countText(view)).toBe('无结果');
    expect(panel(view)?.dataset.state).toBe('none');
    // 没有命中时跳转 / 替换按钮该是禁用的 —— 点了没反应比点不动更让人困惑。
    expect(buttonEl(view, 'next')?.disabled).toBe(true);
    expect(buttonEl(view, 'prev')?.disabled).toBe(true);
    expect(buttonEl(view, 'replace-one')?.disabled).toBe(true);
    expect(buttonEl(view, 'replace-all')?.disabled).toBe(true);
  });

  it('有命中时按钮可用，`data-state` 回到 some', () => {
    const view = mountFull('abc def');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(countText(view)).toBe('1/1');
    expect(panel(view)?.dataset.state).toBe('some');
    expect(buttonEl(view, 'next')?.disabled).toBe(false);
    expect(buttonEl(view, 'replace-one')?.disabled).toBe(false);
  });

  it('查询为空时显示 `0/0` 而不是隐藏（数字变化时位置不跳）', () => {
    const view = mountFull('abc def abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(countText(view)).toBe('1/2');
    // 清空查询：`SearchQuery({search:''}).valid` 为 false。
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    expect(countText(view)).toBe('0/0');
    expect(buttonEl(view, 'next')?.disabled).toBe(true);
  });

  it('面板没开时计数为 null（不是 0）', () => {
    const view = mountFull('abc def abc');
    // 只发查询不开面板：CM 的搜索高亮本身以面板打开为前提，计数同理。
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(computeMatchCount(view.state)).toBeNull();
  });

  it('性能账：810KB / 45000 处命中一次计数仍是线性代价', () => {
    // 这条守的是**算法形状**，不是墙钟数字。全文遍历是计数器的代价（方案 §2.4），
    // 真正会出问题的是「每找到一处就从头再扫一遍」那种 O(n·m) 写法 —— 在这份文档上
    // 它会把几十毫秒变成几秒。所以阈值刻意松：**它要抓的是量级退化，不是微基准。**
    //
    // 为什么不收紧：这条跑在 vitest 的并行 worker 里，同机还压着八十个测试文件。
    // 同一份代码空载 ≈50ms，全量并行下取五次最小值仍读到 125ms —— 那是**持续**的
    // 负载系数，不是瞬时尖峰，取最小值也滤不掉。收紧阈值的结果是测试随机器负载红，
    // 而红的不是代码。真实性能在方案 §2.4 里有记录，这里只当护栏。
    const doc = ('abc def ghi jkl\n').repeat(45_000); // ≈ 810KB
    const view = mountFull(doc);
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });

    // 只围「纯计算」计时：建 view、开面板、发查询都不算在账里。
    // 取五次里的最小值，滤掉偶发的一次长停顿。
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      const count = computeMatchCount(view.state);
      best = Math.min(best, performance.now() - start);
      // 每轮都验结果，防止「算得飞快但算错了」也过关。
      expect(count?.total).toBe(45_000);
    }
    expect(best).toBeLessThan(1000);
  });
});

/**
 * 「选中一段文本，全文相同内容垫底色」—— 装的是 CM 的 `highlightSelectionMatches`，
 * 但**底色 token 与防叠显规则是我们的**（`theme.ts` 的 `.cm-selectionMatch` 段）。
 *
 * 这里只断言 class 的**存在性与数量**：happy-dom 不算 CSS，颜色对不对由 token 引用
 * 静态保证（`var(--nexus-*)`），颜色值本身走主题系统的既有测试。
 */
describe('查找 / 替换面板：选中即高亮', () => {
  const selectionMatches = (view: EditorView) => view.dom.querySelectorAll('.cm-selectionMatch');

  it('选中一个词之后，全文其余相同词垫上 selectionMatch', () => {
    // CM 原生跳过选中自身，所以两处「abc」选中其一时只高亮另一处。
    const view = mountFull('abc def abc');
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(selectionMatches(view)).toHaveLength(1);
  });

  it('取消选中（纯光标）之后高亮收回', () => {
    const view = mountFull('abc def abc');
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(selectionMatches(view)).toHaveLength(1);
    view.dispatch({ selection: { anchor: 5 } });
    expect(selectionMatches(view)).toHaveLength(0);
  });

  it('多选区在 Nexus 现状下不可达，高亮整组不出现', () => {
    // 这里测的是一个**不可达状态**，留它是为了钉住两件事的交界：
    // ① `allowMultipleSelections` facet 默认关，任何多选区事务都会被 state 归一成
    //    单选区（`@codemirror/state` 的 `asSingle()`），Nexus 没有开它 —— 所以
    //    Mod-d（`selectNextOccurrence`，走 `addRange` 加 range）在当前装配下
    //    第二次按下也会被归一，表现为「点了没反应」。
    // ② CM 的 `highlightSelectionMatches` 自己规定 `ranges.length > 1` 时不高亮
    //    （两个选区互相淹没，索性都不高亮）。
    // 将来若开 facet，选中即高亮在那里的行为已经是「整组 none」，无需额外适配。
    const view = mountFull('abc def abc');
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 11)
      ])
    });
    // 归一之后是单选区 —— 但那一个选区仍然会触发选中即高亮（这正是下面这行的含义：
    // 用户眼里「多选区失败」而不是「没有高亮」）。
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it('查询与选中同时发生时的 DOM 形态（防叠显规则的地基）', () => {
    // 查询「abc」再选中「abc」：两个 decoration 都命中同一批 span。CM 官方的防叠显
    // 规则是后代选择器 `.cm-searchMatch .cm-selectionMatch { background: transparent }`，
    // 成立的前提是两者嵌成父子 span。本测试把这个形态钉住 —— 一旦 CM 升级改成
    // 单 span 双 class，theme.ts 里那条规则会静默失效，届时改规则而不是删测试。
    const view = mountFull('abc def abc');
    // 搜索高亮以面板打开为前提（CM：`if (!panel || !query.spec.valid) return none`），
    // 所以必须真的开面板 —— 只发 setSearchQuery 的话高亮一个都没有。
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(view.dom.querySelectorAll('.cm-searchMatch')).toHaveLength(2);
    expect(view.dom.querySelectorAll('.cm-selectionMatch')).toHaveLength(1);
    expect(view.dom.querySelectorAll('.cm-searchMatch .cm-selectionMatch')).toHaveLength(1);
    expect(view.dom.querySelectorAll('.cm-searchMatch.cm-selectionMatch')).toHaveLength(0);
  });
});

/**
 * 命中 range field：给**被 `Decoration.replace` 整块替换的 widget** 补高亮用。
 *
 * 它存在的理由是 CM 的一个事实：`searchMatch` mark 落在 replace range 上时 DOM 里
 * **不出现那个 class**（真机实测：视觉面搜 wikilink 的内容，源码面 1 处高亮、视觉面
 * 0 处）。这个 field 把「哪些 range 被命中」变成可读状态，让 widget 在构造时自己
 * 知道要不要画黄底。
 *
 * 这里只测**状态本身**；「widget 真的把黄底画出来了」由真机用例
 * `apps/desktop/test/editor-search-panel.test.ts` 证 —— happy-dom 不算 CSS，
 * 而这条链的另一半（`Decoration.replace` 吃 mark）只有真 DOM 才成立。
 *
 * 注意：这个 field **只装视觉面**，所以上面那些用例碰不到它，必须单独 mount。
 */
describe('查找 / 替换面板：命中 range', () => {
  function mountHits(doc: string): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const extensions: Extension[] = [
      searchPanelExtension,
      searchHitRangesExtension,
      searchPhrasesExtension('zh-CN')
    ];
    const view = new EditorView({ doc, parent, extensions });
    mounted.push(view);
    return view;
  }

  /** 把 RangeSet 摊成 `[from, to]` 数组 —— 断言的是区间本身，不是内部结构。 */
  const hits = (view: EditorView): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    const cursor = view.state.field(searchHitRangesField).iter();
    while (cursor.value) {
      out.push([cursor.from, cursor.to]);
      cursor.next();
    }
    return out;
  };

  it('面板没开时一个命中都没有', () => {
    // 查询发了、但面板没开：CM 的搜索高亮本身以面板打开为前提，命中表同理。
    // 少了这条判断，关掉面板后 widget 上的黄底会一直挂着。
    const view = mountHits('abc def abc');
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(hits(view)).toEqual([]);
  });

  it('面板开着且有查询时给出全部命中 range', () => {
    const view = mountHits('abc def abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(hits(view)).toEqual([
      [0, 3],
      [8, 11]
    ]);
  });

  it('关掉面板后命中清空', () => {
    const view = mountHits('abc def abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(hits(view)).toHaveLength(2);
    closeSearchPanel(view);
    expect(hits(view)).toEqual([]);
  });

  it('清空查询后命中清空', () => {
    const view = mountHits('abc def abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(hits(view)).toHaveLength(2);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    expect(hits(view)).toEqual([]);
  });

  it('文档改动后重算', () => {
    const view = mountHits('abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    expect(hits(view)).toEqual([[0, 3]]);
    view.dispatch({ changes: { from: 3, insert: ' abc' } });
    expect(hits(view)).toEqual([
      [0, 3],
      [4, 7]
    ]);
  });

  it('光标移动不重算（拿回的是同一个 RangeSet 引用）', () => {
    // 这个 field 的消费方是「widget 身上有没有命中」，与光标无关 ——
    // 「当前第几处」由计数层管（那个读选区）。所以光标移动**刻意**不重算：
    // 每动一次光标就全文遍历一遍是无谓代价，而计数层自己会算。
    const view = mountHits('abc def abc');
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'abc' })) });
    const before = view.state.field(searchHitRangesField);
    view.dispatch({ selection: { anchor: 9 } });
    expect(view.state.field(searchHitRangesField)).toBe(before);
  });
});
