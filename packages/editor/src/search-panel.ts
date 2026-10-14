import {
  Compartment,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
  type Extension
} from '@codemirror/state';
import { type Command, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  setSearchQuery
} from '@codemirror/search';
import { translate } from '@nexus/i18n';

/**
 * 文件内查找 / 替换面板。
 *
 * ## 面板是自绘的，搜索逻辑一件都不自己做
 *
 * 长什么样完全由这里决定（`search({ createPanel })`），但搜索本身全部复用 CM：
 * 查询存在 `searchQuery` field 里（`setSearchQuery` effect 写入）、跳转走
 * `findNext` / `findPrevious`、替换走 `replaceNext` / `replaceAll`、关闭走
 * `closeSearchPanel`、开合由 `searchPanelOpen` 判。于是 `cm-searchMatch` 高亮、
 * 一步一撤销的替换事务、只读保护、读屏播报全是 CM 的既有行为。
 *
 * ## 为什么不用内置面板
 *
 * `search({ top: true })` 的内置面板是编辑器**上方一条横贯的占流区域**，会把正文
 * 往下挤；而 VS Code / markra / open-knowledge 三家参考都是**右上角悬浮卡片**。
 * 内置面板的 DOM 是 `flex-wrap` + `<br>` 换行 + 绝对定位的关闭按钮，做不出那个形态 ——
 * 用 CSS 硬掰只会越掰越像补丁（掰到一半的中间态见
 * `tmp/search-panel.before-selftdraw.bak.ts`：图标化、计数注入、折叠 class 全都要靠
 * 「往别人的 DOM 里塞东西」实现）。
 *
 * ## 必须自己兜住的四件事
 *
 * 1. **`main-field`**：`openSearchPanel` 靠 `getPanel(...).dom.querySelector('[main-field]')`
 *    找输入框并聚焦。查找框上少这个属性，`Mod-f` 打开后焦点不会落进去。
 * 2. **`update()` 里的查询同步**：查询可能被面板之外改掉（`openSearchPanel` 拿当前选区
 *    兜底造一个、宿主命令改查询）。CM 的做法是比对 `setSearchQuery` effect 再写回输入框，
 *    这里照做 —— 少了它，面板显示的查询会和实际搜索的查询脱节。
 * 3. **`Escape` / `Enter` / `F3`**：内置面板靠模块私有的 `runScopeHandlers` 跑
 *    `searchKeymap` 的 `search-panel` 作用域，那个函数不导出，所以这里自己判。
 * 4. **`get top()`**：`PanelGroup` 按 `panel.top` 决定把面板挂进 `.cm-panels-top` 还是
 *    `.cm-panels-bottom`。漏了它面板会跑到编辑器**下方**（默认 falsy），而样式是按
 *    top 那组写的。
 *
 * ## 面板实例活不过一次关开
 *
 * `searchPanel` field 存的是**构造函数引用**，`panelPlugin.update` 在 spec 变化时
 * `spec(view)` 新建实例（关闭时 `destroy()`）。所以任何要跨开关保持的状态都不能放在
 * 实例上 —— 展开态因此存在 `replaceExpandedField` 里，计数与查询一律现读 `view.state`。
 */

/* ---- 1. 文案 ---- */

/**
 * `EditorState.phrases` 这张表装两类键，一起随界面语言换：
 *
 * - **CM 自己会查的英文短语**（读屏播报用）。键必须与 `@codemirror/search` 里的字面量
 *   **逐字一致** —— 那是个查表，写错一个字母那一条就回落英文。
 * - **自绘面板的文案**。键就是 `@nexus/i18n` 的键本身。挂进这张表**不是为了查表语义**，
 *   是为了蹭它的换语言通道：`phrases` 是 compartment，重配即全量替换，面板读
 *   `view.state.phrase(key)` 就自动跟着当前语言走。**不另引 locale facet** —— 那会与
 *   `source-editor.ts` 形成循环 import（它引本文件拿 `searchPanelExtension`）。
 */
const CM_PHRASE_KEYS: Readonly<Record<string, string>> = {
  // 带 `$` 的是 CM 的占位符，ValueMirror 只做原样替换，所以译文里也必须留着它（且只剩一个）。
  'current match': 'editor.search.currentMatch',
  'on line': 'editor.search.onLine',
  'replaced match on line $': 'editor.search.replacedMatchOnLine',
  'replaced $ matches': 'editor.search.replacedMatches'
};

/** 自绘面板要读的 i18n 键。面板一律 `view.state.phrase(key)` 取，键值同名。 */
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
] as const;

/**
 * 按语言生成 `EditorState.phrases` 表。
 *
 * 只覆盖我们给出的那些键：`phrases` 是**增量**覆盖，没给到的键继续用 CM 的默认英文。
 * 拼完整张 = 把 CodeMirror 所有短语抄一遍，升级它就多一处要人工对账的地方。
 */
export function localizedSearchPhrases(locale: string): Readonly<Record<string, string>> {
  const phrases: Record<string, string> = {};
  for (const [englishPhrase, key] of Object.entries(CM_PHRASE_KEYS)) {
    phrases[englishPhrase] = translate(locale, key);
  }
  for (const key of PANEL_KEYS) {
    phrases[key] = translate(locale, key);
  }
  return phrases;
}

/**
 * 面板文案那份 compartment。装的是 `EditorState.phrases` 这一份扩展，
 * 不是语言名 —— 装语言名就没法用 `of()` 直接生成扩展了。
 */
export const searchPhraseCompartment = new Compartment();

/** 建 state 时那一份文案。给 `getSourceEditorExtensions` 用。 */
export function searchPhrasesExtension(locale: string): Extension {
  return searchPhraseCompartment.of(EditorState.phrases.of(localizedSearchPhrases(locale)));
}

/**
 * 换语言时用的那个 effect。单独导出是为了让 `setEditorLocale` 能把它和自己的
 * 重配**放进同一次 dispatch** —— 分两次发的话，界面会先翻一半，
 * 用户看得到「行内浮层是中文、面板还是英文」。
 */
export function searchPanelLocaleEffect(locale: string): StateEffect<unknown> {
  return searchPhraseCompartment.reconfigure(EditorState.phrases.of(localizedSearchPhrases(locale)));
}

/* ---- 2. 替换行的展开态 ---- */

/**
 * 替换行展开态。**是视图状态，不是设置项** —— 每次打开面板都要重设一遍的东西不进设置。
 *
 * 存在 state 而不是面板实例上：面板实例每次打开都新建（见文件头），实例字段活不过
 * 一次关开。`Mod-f` 打开时收起替换行、`Mod-h` 打开时展开，都是往这里写。
 */
export const replaceExpandedField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setReplaceExpandedEffect)) return effect.value;
    }
    return value;
  }
});

export const setReplaceExpandedEffect = StateEffect.define<boolean>();

/**
 * 写入展开态。**值没变也发事务** —— 面板的 `update()` 才跑得起来、DOM 才同步。
 *
 * 不能只在「值变了」时发：面板已经开着、焦点又正好在查找框时，`openSearchPanel`
 * 的内部判断会让它**一个事务都不发**，用户按 `Mod-f` 看到替换行还在。
 * 这个 effect 不带 changes / selection，所以 history 不会记它。
 */
export function setReplaceExpanded(view: EditorView, expanded: boolean): void {
  view.dispatch({ effects: setReplaceExpandedEffect.of(expanded) });
}

/* ---- 3. 两个入口 ---- */

/**
 * 「查找」入口：打开面板、焦点落在**查找框**、**收起替换行**。
 *
 * 焦点不用自己放：`openSearchPanel` 会 focus 带 `main-field` 的那个输入框，
 * 面板首次挂载时 `mount()` 也会 focus + select。
 */
export const openFindPanel: Command = (view) => {
  setReplaceExpanded(view, false);
  openSearchPanel(view);
  return true;
};

/**
 * 「替换」入口：同一个面板、**展开替换行**、焦点落在替换框。
 *
 * 这才是 `Mod-h` 与 `Mod-f` 该有的区别 —— 打开同一个面板、焦点也在同一处的话，
 * 用户分不出自己按的是哪一个，而组合键提示里明明写着两个名字。
 */
export const openReplacePanel: Command = (view) => {
  setReplaceExpanded(view, true);
  openSearchPanel(view);
  // 焦点要在替换框。`openSearchPanel` 只认 `[main-field]`（查找框），所以这里自己挪。
  // 只读文档没有替换行（`display: none` 的元素 focus 不上）—— 那时退回查找框，
  // 至少面板开了，焦点不会跑到编辑器外面去。
  //
  // 注意不能用 `replace?.focus() ?? search?.focus()` —— `focus()` 返回 `undefined`，
  // 那道 `??` 会**永远**执行右边，把刚放好的焦点又抢回去。
  const replaceField = view.dom.querySelector<HTMLInputElement>(
    '.nexus-find input[name="replace"]'
  );
  if (replaceField && !view.state.readOnly) replaceField.focus();
  return true;
};

/* ---- 4. 图标 ---- */

/**
 * 面板上的图形。内联 SVG 而不是图标字体：`packages/editor` 没有图标库
 * （宿主那套 React 图标组件在这里用不了），而 `code-block.ts` / `table-block.ts`
 * 已经是「静态 SVG 常量字符串 + innerHTML」的先例。
 *
 * 尺寸交给 CSS（`.nexus-find svg`），这里只写形状 —— 描边用 `currentColor`，
 * 于是颜色跟着按钮的 `color` 走，悬停与按下态都不用另写一套图标。
 */
const ICON = {
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  previous:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  replaceCollapsed:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  replaceExpanded:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
} as const;

/* ---- 5. 匹配计数 ---- */

/** 计数器的一个刻度。`current` 是「光标处或之后第一处」的序号；无匹配时为 0。 */
export interface MatchCount {
  total: number;
  current: number;
}

/**
 * 全文匹配数与「当前第几处」。
 *
 * 遍历走 `SearchQuery.getCursor` 而不是自己 `new SearchCursor`：大小写、正则、
 * 全字三态的边界（含 `wholeWord` 的前后字符检查、`literal` 的反斜杠转义）都在
 * 那一个方法里，照抄一遍就等于把三份判据复制成四份。
 *
 * `current` 的取法：光标**停在某一处匹配中间**时那一处算当前（用 `to > head` 而不是
 * `from >= head` —— 后者会把光标所在的匹配整处跳过去）。光标在全部匹配之后时 wrap
 * 回最后一处，与 `findNext` 的环绕语义一致。
 *
 * 面板关着时高亮本身就不存在（CM：`if (!panel …) return none`），计数同样不该有。
 */
export function computeMatchCount(state: EditorState): MatchCount | null {
  if (!searchPanelOpen(state)) return null;

  const query = getSearchQuery(state);
  if (!query.valid) return null;

  let total = 0;
  let current = 0;
  let currentFound = false;
  const head = state.selection.main.from;

  const cursor = query.getCursor(state, 0, state.doc.length);
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    const { to } = match.value;
    total += 1;
    if (!currentFound && to > head) {
      current = total;
      currentFound = true;
    }
  }

  return { total, current: currentFound ? current : total };
}

/* ---- 6. 面板本体 ---- */

/** 面板零件的标识。测试与宿主命令靠它找元素，改名等于改契约。 */
const PART = {
  search: 'search',
  replace: 'replace',
  replaceOne: 'replace-one',
  replaceAll: 'replace-all',
  previous: 'prev',
  next: 'next',
  case: 'case',
  word: 'word',
  re: 're',
  close: 'close',
  toggleReplace: 'toggle-replace'
} as const;

/**
 * 自绘的查找面板。
 *
 * DOM 在构造时一次建好（含替换行），此后 `update()` **只写属性与文本**、不重建结构：
 * 展开态、只读、有无命中都是 `data-*` 属性，由 CSS 决定显隐。这样同步是幂等的，
 * 也不会因为重建 DOM 把焦点弄丢 —— 用户正在输入时 `update` 每次按键都会跑。
 */
class NexusFindPanel implements Panel {
  readonly dom: HTMLElement;

  private readonly searchInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly countElement: HTMLElement;
  private readonly toggleReplaceButton: HTMLButtonElement;
  private readonly replaceOneButton: HTMLButtonElement;
  private readonly replaceAllButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly pressedSwitches = new Map<string, HTMLButtonElement>();
  /** 「按钮 → 它的 aria-label 的 i18n 键」。换语言时整批重写。 */
  private readonly labelledButtons: Array<[HTMLElement, string]> = [];

  /** 面板自己认为的查询。比对 `setSearchQuery` effect 用 —— 相等就不写回输入框。 */
  private query: SearchQuery;
  /** 上次渲染的计数文案，相同就不碰 DOM。 */
  private renderedCount = '';
  /**
   * 上次渲染的展开态。`innerHTML` 是这里唯一一处「解析」代价（其余全是属性写入），
   * 而 `sync()` 每次按键都会跑 —— 加个记忆值，没变就不重画那个箭头。
   */
  private renderedExpanded: boolean | null = null;
  /** 上次量到的滚动条宽度。`-1` = 还没量过。见 `syncGutter()`。 */
  private gutter = -1;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);

    this.searchInput = this.buildInput(PART.search, 'editor.search.find');
    // `main-field` 是 CM 的契约：`openSearchPanel` 靠它找「该聚焦哪个输入框」。
    this.searchInput.setAttribute('main-field', 'true');
    this.replaceInput = this.buildInput(PART.replace, 'editor.search.replace');
    // 打开时查询可能已经非空（`openSearchPanel` 拿选区兜底造了一个）—— 必须回填，
    // 否则输入框是空的而搜索用的是别的词，正是文件头警告的那种脱节。
    this.searchInput.value = this.query.search;
    this.replaceInput.value = this.query.replace;

    this.countElement = document.createElement('span');
    this.countElement.className = 'nexus-find-count';
    // 读屏播报：跳转后「第几处」会变，`polite` 让它在不打断用户的前提下念出来。
    this.countElement.setAttribute('role', 'status');
    this.countElement.setAttribute('aria-live', 'polite');

    this.toggleReplaceButton = this.buildIconButton(
      PART.toggleReplace,
      'editor.search.toggleReplace',
      ICON.replaceCollapsed
    );
    this.toggleReplaceButton.addEventListener('click', () => {
      setReplaceExpanded(this.view, !this.view.state.field(replaceExpandedField, false));
    });

    this.previousButton = this.buildIconButton(
      PART.previous,
      'editor.search.previous',
      ICON.previous
    );
    this.previousButton.addEventListener('click', () => findPrevious(this.view));
    this.nextButton = this.buildIconButton(PART.next, 'editor.search.next', ICON.next);
    this.nextButton.addEventListener('click', () => findNext(this.view));

    const caseButton = this.buildSwitch(PART.case, 'editor.search.matchCase', 'Aa');
    caseButton.addEventListener('click', () =>
      this.commit({ caseSensitive: !getSearchQuery(this.view.state).caseSensitive })
    );
    const wordButton = this.buildSwitch(PART.word, 'editor.search.byWord', 'ab');
    wordButton.addEventListener('click', () =>
      this.commit({ wholeWord: !getSearchQuery(this.view.state).wholeWord })
    );
    const reButton = this.buildSwitch(PART.re, 'editor.search.regexp', '.*');
    reButton.addEventListener('click', () =>
      this.commit({ regexp: !getSearchQuery(this.view.state).regexp })
    );

    const closeButton = this.buildIconButton(PART.close, 'editor.search.close', ICON.close);
    closeButton.addEventListener('click', () => closeSearchPanel(this.view));

    this.replaceOneButton = this.buildTextButton(PART.replaceOne, 'editor.search.replaceOne');
    this.replaceOneButton.addEventListener('click', () => replaceNext(this.view));
    this.replaceAllButton = this.buildTextButton(PART.replaceAll, 'editor.search.replaceAll');
    this.replaceAllButton.addEventListener('click', () => replaceAll(this.view));

    // 查找行。顺序照 VS Code：折叠箭头 → 放大镜 → 输入框 → 计数 → ↑ ↓ → 分隔 → Aa ab .* → ×
    const searchRow = buildRow([
      this.toggleReplaceButton,
      this.buildLeading(),
      this.searchInput,
      this.countElement,
      this.previousButton,
      this.nextButton,
      buildSeparator(),
      caseButton,
      wordButton,
      reButton,
      closeButton
    ]);
    // 替换行。开头的占位块与查找行的折叠按钮同宽 —— 两行的输入框左边对齐（VS Code 也是）。
    const replaceRow = buildRow([
      buildPlaceholder(),
      this.buildLeading(),
      this.replaceInput,
      this.replaceOneButton,
      this.replaceAllButton
    ]);
    replaceRow.classList.add('nexus-find-replace-row');

    this.dom = document.createElement('div');
    this.dom.className = 'nexus-find';
    this.dom.setAttribute('role', 'search');
    this.dom.append(searchRow, replaceRow);

    this.searchInput.addEventListener('keydown', (event) => this.handleSearchKeydown(event));
    this.replaceInput.addEventListener('keydown', (event) => this.handleReplaceKeydown(event));
    this.dom.addEventListener('keydown', (event) => this.handlePanelKeydown(event));

    this.syncGutter();
    this.sync();
  }

  /** `PanelGroup` 按它决定挂进 `.cm-panels-top` 还是 `.cm-panels-bottom`。 */
  get top(): boolean {
    return true;
  }

  /**
   * `Panel.mount` —— 面板挂上 DOM 之后调。
   *
   * 聚焦 + 选中是「打开面板时焦点该落在哪」的答案。`openSearchPanel` 只在面板**已经
   * 开着**时才会去 focus 输入框（首次打开那一刻它拿到的是挂载前的 DOM，查不到），
   * 所以首次打开全靠这里。
   */
  mount(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  /**
   * `Panel.update` —— 每次视图更新都跑，所以每一件事都要幂等。
   *
   * 不挑更新类型：查询变化、光标移动（计数会变）、换语言（phrases 重配）、
   * 只读切换、展开态变化都要重新同步。
   */
  update(update: ViewUpdate): void {
    // 几何变了才重量滚动条（见 `syncGutter`）。文档长到出现滚动条、窗口改大小都会
    // 带上这个标志，而每次按键不会 —— 所以这条不会把布局读带进输入路径。
    if (update.geometryChanged) this.syncGutter();
    // 查询被面板之外改掉时写回输入框。比对 effect 而不是无条件写 ——
    // 无条件写会在用户输入中途把光标顶到末尾。
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.searchInput.value = effect.value.search;
          this.replaceInput.value = effect.value.replace;
        }
      }
    }
    this.sync();
  }

  /**
   * 让卡片右侧避开滚动条。
   *
   * 容器贴的是 `.cm-editor` 的右边缘，而滚动条是 `.cm-scroller` 的（`overflow: auto`）、
   * 就在 `.cm-editor` 里面 —— 不让开的话卡片会压住滚动条的上半截。CSS 里没有「相对
   * scroller 的 client box 定位」这种写法，只能自己让出那几像素。
   *
   * 宽度**现量**而不是写死：`offsetWidth - clientWidth` 就是滚动条占的那几像素。
   * 别信「经典滚动条 15px」这个说法 —— 2026-10-14 实测本机 Electron/Windows 是 **17px**，
   * 差 2px 就是「压住」与「不压住」的区别。覆盖层滚动条的平台（macOS）量出来是 0，
   * 本来也不用让。量到的值写在自己身上的 `--nexus-find-gutter`，`theme.ts` 用
   * `margin-right` 与 `width` 读它。
   *
   * 只在 `update.geometryChanged` 时重量 —— 那个标志包含「`scrollDOM.clientWidth`
   * 变了」这一条（`@codemirror/view/dist/index.js:6352`），所以文档长到出现滚动条、
   * 窗口改大小都会重算，而每次按键不会（读布局属性会强制回流，不能进输入路径）。
   */
  private syncGutter(): void {
    const scroller = this.view.scrollDOM;
    const gutter = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    if (gutter === this.gutter) return;
    this.gutter = gutter;
    this.dom.style.setProperty('--nexus-find-gutter', `${gutter}px`);
  }

  /** 把 state 上的查询与界面语言同步到 DOM。幂等，可重复调。 */
  private sync(): void {
    const state = this.view.state;
    const query = getSearchQuery(state);

    // 语言：文案全从 `phrases` 取，重配即变，所以每次同步都写一遍（幂等，代价是几个属性）。
    this.dom.setAttribute('aria-label', state.phrase('editor.search.panelLabel'));
    this.searchInput.placeholder = state.phrase('editor.search.find');
    this.replaceInput.placeholder = state.phrase('editor.search.replace');
    for (const [element, key] of this.labelledButtons) {
      const label = state.phrase(key);
      element.setAttribute('aria-label', label);
      element.title = label;
    }
    this.replaceOneButton.textContent = state.phrase('editor.search.replaceOne');
    this.replaceAllButton.textContent = state.phrase('editor.search.replaceAll');

    // 三开关的按下态直接读 state —— 用户可能用 keymap 改（`Mod-Alt-c` 之类）而不是点按钮。
    this.setPressed(PART.case, query.caseSensitive);
    this.setPressed(PART.word, query.wholeWord);
    this.setPressed(PART.re, query.regexp);

    // 只读：CM 内置面板在只读时不渲染替换行，这里用属性让 CSS 收起它（结构不重建）。
    this.dom.dataset.readonly = String(state.readOnly);

    // 展开态。
    const expanded = state.field(replaceExpandedField, false) ?? false;
    this.dom.dataset.replace = expanded ? 'open' : 'closed';
    this.toggleReplaceButton.setAttribute('aria-expanded', String(expanded));
    if (this.renderedExpanded !== expanded) {
      this.toggleReplaceButton.innerHTML = expanded ? ICON.replaceExpanded : ICON.replaceCollapsed;
      this.renderedExpanded = expanded;
    }

    this.renderCount(query);
  }

  private renderCount(query: SearchQuery): void {
    const count = computeMatchCount(this.view.state);
    const hasQuery = query.valid && query.search !== '';
    // 查询为空 / 无效：显示 `0/0` 而不是隐藏 —— 位置固定，数字变化时不会跳。
    const text = !count || !hasQuery
      ? '0/0'
      : count.total === 0
        ? this.view.state.phrase('editor.search.noResults')
        : `${count.current}/${count.total}`;

    // 有查询但零命中：给整张卡片一个状态标记，CSS 用它把计数换成警示色。
    this.dom.dataset.state = hasQuery && count !== null && count.total === 0 ? 'none' : 'some';

    if (text !== this.renderedCount) {
      this.countElement.textContent = text;
      this.renderedCount = text;
    }

    // 没有命中时跳转按钮该是禁用的 —— 点了没反应比点不动更让人困惑。
    const navigable = count !== null && count.total > 0;
    this.previousButton.disabled = !navigable;
    this.nextButton.disabled = !navigable;
    const replaceable = navigable && !this.view.state.readOnly;
    this.replaceOneButton.disabled = !replaceable;
    this.replaceAllButton.disabled = !replaceable;
  }

  /** 把输入框的值 + 三个开关合成一次查询提交。开关点击与输入框 `input` 都走这里。 */
  private commit(patch: Partial<{ caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>): void {
    const current = getSearchQuery(this.view.state);
    const next = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: patch.caseSensitive ?? current.caseSensitive,
      wholeWord: patch.wholeWord ?? current.wholeWord,
      regexp: patch.regexp ?? current.regexp
    });
    if (next.eq(this.query)) return;
    // 先记下来再 dispatch：`update()` 靠 `effect.value.eq(this.query)` 判断「是不是自己
    // 发的」，不先记就会把自己的提交当成外部改动、把输入框的值再写一遍（光标跳到末尾）。
    this.query = next;
    this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    (event.shiftKey ? findPrevious : findNext)(this.view);
  }

  private handleReplaceKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    replaceNext(this.view);
  }

  /**
   * 面板级的键。**CM 内置面板靠 `runScopeHandlers` 跑 `searchKeymap` 的 `search-panel`
   * 作用域，那个函数不导出**，所以这里自己判 —— 少一条的表现是「面板里按 Esc 关不掉」。
   *
   * 焦点在面板里时编辑器的 keymap 收不到事件（`.cm-panels` 在 `contentDOM` 之外），
   * 所以这些键只能由面板自己接。
   */
  private handlePanelKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(this.view);
      return;
    }
    // F3 / Mod-g 在面板里也该认（与编辑器里同一套语义）。`Mod-Alt-g`（跳转到行）不接管。
    const isFindKey =
      event.key === 'F3' ||
      (event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey) && !event.altKey);
    if (isFindKey) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    }
  }

  private setPressed(name: string, pressed: boolean): void {
    this.pressedSwitches.get(name)?.setAttribute('aria-pressed', String(pressed));
  }

  private buildInput(name: string, labelKey: string): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'nexus-find-input';
    input.type = 'text';
    input.name = name;
    // 关掉自动填充与拼写检查：面板输入的是搜索词，被浏览器「纠正」或弹出历史都不对。
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', this.view.state.phrase(labelKey));
    this.labelledButtons.push([input, labelKey]);
    input.addEventListener('input', () => this.commit({}));
    return input;
  }

  private buildIconButton(name: string, labelKey: string, icon: string): HTMLButtonElement {
    const button = this.buildButton(name, labelKey);
    button.className = 'nexus-find-icon';
    button.innerHTML = icon;
    return button;
  }

  private buildSwitch(name: string, labelKey: string, text: string): HTMLButtonElement {
    const button = this.buildButton(name, labelKey);
    button.className = 'nexus-find-switch';
    button.setAttribute('aria-pressed', 'false');
    button.textContent = text;
    this.pressedSwitches.set(name, button);
    return button;
  }

  private buildTextButton(name: string, labelKey: string): HTMLButtonElement {
    const button = this.buildButton(name, labelKey);
    button.className = 'nexus-find-text';
    return button;
  }

  private buildButton(name: string, labelKey: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.name = name;
    this.labelledButtons.push([button, labelKey]);
    return button;
  }

  private buildLeading(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'nexus-find-leading';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = ICON.search;
    return span;
  }
}

function buildSeparator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'nexus-find-separator';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/** 替换行行首的占位块，宽度与查找行的折叠按钮一致 —— 两行输入框左边对齐。 */
function buildPlaceholder(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'nexus-find-placeholder';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function buildRow(children: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nexus-find-row';
  row.append(...children);
  return row;
}

/**
 * 面板扩展本体：`search()` + 自绘面板 + 展开态 field，绑成一个扩展。
 *
 * 绑一起是为了不给调用方留「装一半」的机会 —— 展开态 field 缺了的话
 * `setReplaceExpanded` 的 dispatch 无人处理、面板恒读默认值，症状是
 * 「替换行展不开也收不回」，而报错一个都没有。
 *
 * `search()` 这里**不传 `top`**：那个配置只有 CM 内置的 `SearchPanel` 读
 * （它的 `get top()` 去 facet 里取），自绘面板的位置由自己的 `get top()` 说了算。
 * 传了也不生效，反而像是「位置靠这个参数控制」。
 */
export const searchPanelExtension: Extension = [
  search({ createPanel: (view) => new NexusFindPanel(view) }),
  replaceExpandedField
];

/* ---- 7. 搜索命中 range（给投影 widget 补高亮用） ---- */

/**
 * 命中 range 的**值类型**。`RangeSet<T>` 的 `T` 必须是 `RangeValue`（带 `eq` /
 * `mapMode` 等映射语义），而这里**只需要区间本身** —— 消费方 `RangeSet.between()`
 * 直接把 `from` / `to` 交出来，从不读值。所以子类化一个空实现、全程复用同一个
 * 实例：不造对象，也就没有「值变了要不要重算」的问题（区间变了 RangeSet 自己
 * 就不一样，`eq` 走默认的同一性比较）。
 */
class SearchHitRange extends RangeValue {}

/** 命中 range 的共用值。`RangeValue` 各成员都有默认实现，空子类即可。 */
const SEARCH_HIT: RangeValue = new SearchHitRange();

/** 命中区间的表类型。**投影层与 field 共用** —— 别在两处各写一份结构。 */
export type SearchHitRanges = RangeSet<RangeValue>;

/**
 * 当前查询命中的全部 range。**给被 `Decoration.replace` 整块替换的投影 widget 用。**
 *
 * 为什么需要它：CM 的高亮是给匹配 range 打 `cm-searchMatch` mark，而 mark 落在
 * replace range 上时 **DOM 里不会出现那个 class**（真机实测：视觉面搜
 * `[[wiki锚点目标]]` 的内容，源码面 1 处、视觉面 0 处高亮）。被替换的 widget
 * 因此「搜到了但看不见」。这个 field 让 widget 在构造时知道「我身上有命中」，
 * 自己把黄底画出来。
 *
 * 只装**视觉面**（源码面的 wikilink 等就是纯文本，CM 自己的高亮够用）。
 *
 * 重算条件刻意宽松（文档 / 查询变化都重算）：一次 `getCursor` 遍历的代价与
 * CM 自己的 `searchHighlighter` 同量级，而漏一次重算的症状是「widget 上的黄底不消失」。
 */
export const searchHitRangesField = StateField.define<SearchHitRanges>({
  create() {
    return RangeSet.empty;
  },
  update(current, tr) {
    // panel 字段不导出，只能用状态查询判断开合；关着的一律清空（省得 widget 挂着
    // 上一次的命中态）。
    if (!searchPanelOpen(tr.state)) return RangeSet.empty;

    const query = getSearchQuery(tr.state);
    if (!query.valid || query.search === '') return RangeSet.empty;

    // CM 不导出「查询变了」这个事件，只能比对前后查询（`SearchQuery.eq`）。
    const queryChanged = !getSearchQuery(tr.startState).eq(query);
    // 光标移动不重算：field 的消费方是「widget 身上有没有命中」，与光标无关。
    // （「当前第几处」由计数层管，那个读选区。）
    if (!tr.docChanged && !queryChanged) return current;

    const builder = new RangeSetBuilder<RangeValue>();
    const cursor = query.getCursor(tr.state, 0, tr.state.doc.length);
    for (let match = cursor.next(); !match.done; match = cursor.next()) {
      const { from, to } = match.value;
      if (to > from) builder.add(from, to, SEARCH_HIT);
    }
    return builder.finish();
  }
});

/** 命中 range field 的扩展本体。装在视觉面的 `surfaceKindExtensions` 里。 */
export const searchHitRangesExtension: Extension = searchHitRangesField;
