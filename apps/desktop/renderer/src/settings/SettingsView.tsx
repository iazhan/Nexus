import React, { useCallback, useEffect, useRef } from 'react';
import { useLocale } from '../hooks.js';
import { SECTIONS, fieldsOfSection, sectionById, type SectionId } from './registry.js';
import { AppearanceSection } from './AppearanceSection.js';
import { KeybindingsSection } from './KeybindingsSection.js';
import { FieldList } from './FieldRow.js';

/** `role="tab"` 与 `role="tabpanel"` 靠这一对 id 互相指认。 */
const tabId = (id: SectionId): string => `nexus-settings-tab-${id}`;
const panelId = (id: SectionId): string => `nexus-settings-panel-${id}`;

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

export interface SettingsViewProps {
  section: SectionId;
  onSelectSection(section: SectionId): void;
}

/**
 * 设置本体：左栏导航 + 内容区。**不知道自己在窗口里** —— 它现在整个占据设置窗口，
 * 但「怎么关窗」「Escape 做什么」都是窗口的事，归 `SettingsWindow`。
 *
 * 未实现的分组**可点、可进入**，内容区给空态。让它们点不动（`disabled`）就等于「点了没反应」，
 * 那是比空态更糟的反馈；而把它们从导航里删掉，每加一个分组都要改导航结构。
 *
 * 内容区只有三处分派：`appearance`（主题卡片网格）与 `keybindings`（n 行的表 + 跨行冲突检测）
 * 各走专用组件 —— 两者都不是通用控件能表达的；其余 `available` 分组一律走 `FieldList`，
 * 字段按 `section` 从 `FIELDS` 里取，所以「加一个字段」不用改这里。
 */
export const SettingsView: React.FC<SettingsViewProps> = ({ section, onSelectSection }) => {
  const { t } = useLocale();
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const current = sectionById(section);

  /**
   * 切分组把内容区滚回顶部。不这么做会**保留上一个分组的滚动位置** —— 从长分组切到另一个
   * 长分组时用户落在半空中，看不到分组标题（实测：Editor 滚到 859，切到 Files 之后是 9，
   * 那还是被新内容高度夹过的结果）。
   */
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  /**
   * 上下键在七项之间移动**焦点**，只有 `available` 的项会被选中。
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

  return (
    <div className="nexus-settings-view" data-settings-section={section}>
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
        {/* 页面的 `h1`。整个设置窗口只有这一个一级标题 —— 各分组的标题是 `h2`，
            读屏按标题跳转时需要一个根锚点。 */}
        <h1 className="nexus-settings-nav-title">{t('settings.title')}</h1>

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

      <div
        className="nexus-settings-content"
        ref={contentRef}
        role="tabpanel"
        id={panelId(section)}
        aria-labelledby={tabId(section)}
        tabIndex={0}
      >
        {current?.availability !== 'available' ? (
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
