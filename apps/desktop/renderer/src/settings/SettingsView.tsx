import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../hooks.js';
import { SECTIONS, fieldsOfSection, sectionById, type SectionId } from './registry.js';
import { searchSettings, type SettingsSearchHit } from './settings-search.js';
import { AppearanceSection } from './AppearanceSection.js';
import { KeybindingsSection } from './KeybindingsSection.js';
import { FieldList } from './FieldRow.js';

/** `role="tab"` 与 `role="tabpanel"` 靠这一对 id 互相指认。 */
const tabId = (id: SectionId): string => `nexus-settings-tab-${id}`;
const panelId = (id: SectionId): string => `nexus-settings-panel-${id}`;

/** 结果列表的 id。搜索框用 `aria-controls` / `aria-activedescendant` 指着它和它的选项。 */
const resultsId = 'nexus-settings-search-results';
const optionId = (index: number): string => `${resultsId}-${index}`;

/**
 * 命中项高亮亮多久。1.6s 是「够看见、又不至于被当成常驻选中态」的一档 ——
 * 太长会被读成这一项本来的样式，太短则在滚动还没停稳时就没了。
 */
const HIGHLIGHT_MS = 1600;

/** 空态的图标：一个虚线方框加一条短横 —— 「这里预留了位置，但还没有东西」。 */
const EmptyIcon = (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="3 3" />
    <path d="M8 12h8" />
  </svg>
);

/**
 * 把命中的字符包进 `<mark>`。
 *
 * `fuzzyMatch` 给的下标是**升序**的（它按游标一路往前找），所以一趟扫描就够 ——
 * 不用排序，也不会重复包同一个字符。
 */
function withMarks(text: string, positions: readonly number[]): React.ReactNode {
  if (positions.length === 0) return text;

  const marked = new Set(positions);
  const parts: React.ReactNode[] = [];
  let plain = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (!marked.has(index)) {
      plain += char;
      continue;
    }
    if (plain !== '') {
      parts.push(plain);
      plain = '';
    }
    parts.push(<mark key={`mark-${index}`}>{char}</mark>);
  }
  if (plain !== '') parts.push(plain);

  return parts;
}

const SearchResults: React.FC<{
  hits: readonly SettingsSearchHit[];
  activeIndex: number;
  onPick: (hit: SettingsSearchHit) => void;
  onActivate: (index: number) => void;
}> = ({ hits, activeIndex, onPick, onActivate }) => {
  const { t } = useLocale();

  if (hits.length === 0) {
    return (
      <p className="nexus-settings-search-empty" data-search-empty="">
        {t('settings.searchEmpty')}
      </p>
    );
  }

  return (
    <ul
      className="nexus-settings-search-results"
      id={resultsId}
      role="listbox"
      aria-label={t('settings.searchResultsAria')}
    >
      {hits.map((hit, index) => (
        <li
          key={hit.key}
          id={optionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          className="nexus-settings-search-hit"
          data-search-hit={hit.key}
          data-search-active={index === activeIndex ? '' : undefined}
          onClick={() => onPick(hit)}
          /* 鼠标停在哪一行，键盘落点就跟到哪 —— 不跟的话「看起来高亮的那条」与
             「回车会选中的那条」是两个不同的东西，用户按回车会拿到另一项。 */
          onMouseEnter={() => onActivate(index)}
        >
          <span className="nexus-settings-search-hit-label">
            {withMarks(hit.label, hit.positions)}
          </span>
          <span className="nexus-settings-search-hit-meta">
            {/* 结果跨分组，所以要写出它属于哪一组 —— 只有一项名字的话，用户点完不知道
                自己被带到了哪里。 */}
            {t(sectionById(hit.section)?.titleKey ?? 'settings.title')}
            {/* 命中的是别名或 id 时把那一串原文画出来。只给标签的话，「敲 dark 得到『模式』」
                看起来像撞运气。 */}
            {hit.via ? <span className="nexus-settings-search-hit-via">{hit.via}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
};

export interface SettingsViewProps {
  section: SectionId;
  onSelectSection(section: SectionId): void;
}

/**
 * 设置本体：左栏（标题 + 搜索 + 导航）+ 内容区。**不知道自己在窗口里** —— 它现在整个占据
 * 设置窗口，但「怎么关窗」「Escape 做什么」都是窗口的事，归 `SettingsWindow`。
 *
 * 未实现的分组**可点、可进入**，内容区给空态。让它们点不动（`disabled`）就等于「点了没反应」，
 * 那是比空态更糟的反馈；而把它们从导航里删掉，每加一个分组都要改导航结构。
 *
 * 内容区只有三处分派：`appearance`（主题卡片网格）与 `keybindings`（n 行的表 + 跨行冲突检测）
 * 各走专用组件 —— 两者都不是通用控件能表达的；其余 `available` 分组一律走 `FieldList`，
 * 字段按 `section` 从 `FIELDS` 里取，所以「加一个字段」不用改这里。
 *
 * **搜索命中时内容区整个换成结果列表**（不是在下拉里浮一层）：搜索结果跨分组，需要的地方比
 * 200px 的侧栏宽得多。选完就清空查询，于是那一页立刻回来。
 *
 * 标题与搜索框**不在 `<nav>` 里**：`role="tablist"` 的直接子元素只该是 tab，而搜索框要落在
 * 标题与分组列表之间。所以左栏多了一层容器，`h1` 与搜索框住它，`nav` 只装 tab。
 */
export const SettingsView: React.FC<SettingsViewProps> = ({ section, onSelectSection }) => {
  const { t } = useLocale();
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const current = sectionById(section);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * 「跳到哪一行」。带 `token` 是为了让**连点同一条结果**也能再触发一次 —— 只存字段 id 的话
   * 第二次 `setState` 是同一个值，React 直接跳过，滚动与高亮都不会发生。
   */
  const [jump, setJump] = useState<{ fieldId: string; token: number } | null>(null);
  const jumpToken = useRef(0);

  /**
   * 结果**不缓存**。全部候选是 8 个分组 + 35 个字段，一次全扫是微秒级；而缓存必须跟着语言失效
   * （标签是翻译出来的），`t` 又是 `useCallback([])` 出来的稳定引用 —— 依赖写成 `[query, t]`
   * 会在换语言之后拿到上一份语言的标签。少一层缓存就少一个这类坑。
   */
  const hits = searchSettings(query, t);
  const searching = query.trim() !== '';
  const active = hits.length > 0 ? Math.min(activeIndex, hits.length - 1) : -1;

  const pick = useCallback(
    (hit: SettingsSearchHit) => {
      setQuery('');
      setActiveIndex(0);
      onSelectSection(hit.section);
      // 分组命中的结果没有可跳转的行（`field === null`）—— 切到那一组就够了。
      if (!hit.field) return;
      jumpToken.current += 1;
      setJump({ fieldId: hit.field.id, token: jumpToken.current });
    },
    [onSelectSection]
  );

  /**
   * 切分组把内容区滚回顶部。不这么做会**保留上一个分组的滚动位置** —— 从长分组切到另一个
   * 长分组时用户落在半空中，看不到分组标题（实测：Editor 滚到 859，切到 Files 之后是 9，
   * 那还是被新内容高度夹过的结果）。
   */
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  /**
   * 选中搜索结果之后：滚到那一项，并**短暂**给它一圈轮廓。
   *
   * 高亮用 `data-search-highlight` 直接写在节点上、由这里的定时器摘掉，**不走 React 状态**：
   * 它是纯粹的瞬时装饰，为它把 `highlight` 从设置视图一路穿到 `FieldRow` 与
   * `AppearanceSection`（五个调用点）再回来，代价远大于收益。React 只清理它自己渲染过的属性，
   * 不会覆盖这个 —— 高亮期间用户在这一行上点一下开关也抹不掉它。
   *
   * 用 `outline` 而不是底色：底色要配内边距才好看，而加内边距会在高亮出现的一瞬间把整页推一下。
   * outline 不参与布局。也**没有过渡动画**，所以 `prefers-reduced-motion` 天然满足。
   *
   * **不给读屏补一条播报**：设置页现有的三个活区都是因为效果落在**别的窗口 / 系统剪贴板**里
   * 才存在的，而这一跳发生在**这个窗口内** —— 分组换了、行还在，用户 Tab 进去就听到它。
   * 同一条判据在这里不成立，所以不加。
   */
  useEffect(() => {
    if (!jump) return;
    const content = contentRef.current;
    if (!content) return;

    // 先摘掉上一处：连着点两条结果时，前一条的定时器会被下面 return 的 cleanup 取消，
    // 不主动清的话它会一直亮着。
    for (const stale of content.querySelectorAll<HTMLElement>('[data-search-highlight]')) {
      delete stale.dataset.searchHighlight;
    }

    const node = content.querySelector<HTMLElement>(`[data-field="${jump.fieldId}"]`);
    if (!node) return;

    node.scrollIntoView({ block: 'center' });
    node.dataset.searchHighlight = '';
    const timer = window.setTimeout(() => {
      delete node.dataset.searchHighlight;
    }, HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [jump]);

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        // 查询非空时 Escape 的意思是「清掉它」，不是「关窗」。`SettingsWindow` 那层靠
        // `defaultPrevented` 判断要不要关窗（它早就这么写了，理由是弹层的 Escape）。
        if (!searching) return;
        event.preventDefault();
        setQuery('');
        setActiveIndex(0);
        return;
      }

      if (hits.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, hits.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const hit = hits[Math.min(activeIndex, hits.length - 1)];
        if (hit) pick(hit);
      }
    },
    [activeIndex, hits, pick, searching]
  );

  /**
   * 上下键在八项之间移动**焦点**，只有 `available` 的项会被选中。
   * 起点取当前焦点而不是 `section` —— 否则焦点停在 `planned` 项上时，第二次按键又从头算。
   */
  const moveFocus = useCallback(
    (delta: number) => {
      const buttons = Array.from(
        navRef.current?.querySelectorAll<HTMLButtonElement>('[data-section]') ?? []
      );
      if (buttons.length === 0) return;

      const focused = buttons.findIndex((button) => button === document.activeElement);
      const base = focused >= 0 ? focused : buttons.findIndex((b) => b.dataset.section === section);
      const target = buttons[(base + delta + buttons.length) % buttons.length];
      if (!target) return;

      target.focus();
      const id = target.dataset.section;
      if (target.dataset.availability === 'available' && id) onSelectSection(id as SectionId);
    },
    [section, onSelectSection]
  );

  const expanded = searching && hits.length > 0;

  return (
    <div className="nexus-settings-view" data-settings-section={section}>
      <div className="nexus-settings-sidebar">
        {/* 页面的 `h1`。整个设置窗口只有这一个一级标题 —— 各分组的标题是 `h2`，
            读屏按标题跳转时需要一个根锚点。 */}
        <h1 className="nexus-settings-nav-title">{t('settings.title')}</h1>

        <input
          type="search"
          className="nexus-settings-search"
          data-settings-search=""
          value={query}
          placeholder={t('settings.searchPlaceholder')}
          aria-label={t('settings.searchPlaceholder')}
          /* 组合框语义：结果是一个 listbox，键盘落点由 `aria-activedescendant` 指过去 ——
             焦点始终留在输入框里，用户能一直改查询。`aria-controls` 只在列表真的存在时写，
             指向一个不存在的 id 比不写更糟。 */
          role="combobox"
          aria-expanded={expanded}
          aria-autocomplete="list"
          aria-controls={expanded ? resultsId : undefined}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            // 查询一变就把落点收回第一条 —— 否则它会停在上一份结果的下标上，而那个下标
            // 在新结果里指向的是另一项。
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
        />

        <nav
          className="nexus-settings-nav"
          ref={navRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label={t('settings.navAria')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {SECTIONS.map((item) => {
            const selected = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={tabId(item.id)}
                aria-selected={selected}
                className={`nexus-settings-nav-item${selected ? ' nexus-settings-nav-item-active' : ''}`}
                data-section={item.id}
                data-availability={item.availability}
                /* 窄窗口下标签被视觉隐藏（见 App.css 的 720px 断点），`title` 是那时唯一
                   能把分组名看全的地方。 */
                title={t(item.titleKey)}
                onClick={() => onSelectSection(item.id)}
              >
                {/* 图标是 `aria-hidden` 的：`aria-selected` 已经说清选中态，分组名才是可读信息，
                    读屏再念一遍图标没有意义。 */}
                <span className="nexus-settings-nav-icon">{item.icon}</span>
                <span className="nexus-settings-nav-label">{t(item.titleKey)}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div
        className="nexus-settings-content"
        ref={contentRef}
        role="tabpanel"
        id={panelId(section)}
        aria-labelledby={tabId(section)}
        tabIndex={0}
      >
        {searching ? (
          <SearchResults
            hits={hits}
            activeIndex={active}
            onPick={pick}
            onActivate={setActiveIndex}
          />
        ) : current?.availability !== 'available' ? (
          <div className="nexus-settings-empty" data-availability="planned">
            <span className="nexus-settings-empty-icon" aria-hidden="true">
              {EmptyIcon}
            </span>
            {/* 空态也要有标题：可用分组各有一个 `h2`，只有这两个没有的话，读屏按标题
                跳转时是「进得来、出不去」—— 不知道自己落在哪一组。 */}
            <h2 className="nexus-settings-empty-title">
              {t(current?.titleKey ?? 'settings.planned')}
            </h2>
            <p className="nexus-settings-empty-text">{t('settings.planned')}</p>
            <p className="nexus-settings-empty-hint">{t('settings.plannedHint')}</p>
          </div>
        ) : section === 'appearance' ? (
          /* 主题卡片网格不是通用控件能表达的，走专用组件；其余分组全是普通字段。 */
          <AppearanceSection />
        ) : section === 'keybindings' ? (
          /* 一张 n 行的表 + 跨行冲突检测，同样不是「一组字段」。 */
          <KeybindingsSection />
        ) : (
          <section className="nexus-settings-section" data-section={section}>
            <h2 className="nexus-settings-section-title">{t(current.titleKey)}</h2>
            <FieldList fields={fieldsOfSection(section)} />
          </section>
        )}
      </div>
    </div>
  );
};
