import React, { useCallback, useRef } from 'react';
import { useLocale } from '../hooks.js';
import { SECTIONS, sectionById, type SectionId } from './registry.js';
import { AppearanceSection } from './AppearanceSection.js';

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
 */
export const SettingsView: React.FC<SettingsViewProps> = ({ section, onSelectSection }) => {
  const { t } = useLocale();
  const navRef = useRef<HTMLElement>(null);
  const current = sectionById(section);

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
        <span className="nexus-settings-nav-title">{t('settings.title')}</span>

        {SECTIONS.map((item) => {
          const selected = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`nexus-settings-nav-item${selected ? ' nexus-settings-nav-item-active' : ''}`}
              data-section={item.id}
              data-availability={item.availability}
              onClick={() => onSelectSection(item.id)}
            >
              {t(item.titleKey)}
            </button>
          );
        })}
      </nav>

      <div className="nexus-settings-content">
        {current?.availability === 'available' ? (
          <AppearanceSection />
        ) : (
          <div className="nexus-settings-empty" data-availability="planned">
            <p className="nexus-settings-empty-text">{t('settings.planned')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
