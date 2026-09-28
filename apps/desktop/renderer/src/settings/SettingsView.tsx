import React, { useCallback, useEffect, useRef } from 'react';
import { useLocale } from '../hooks.js';
import { SECTIONS, sectionById, type SectionId } from './registry.js';
import { AppearanceSection } from './AppearanceSection.js';

export interface SettingsViewProps {
  section: SectionId;
  onSelectSection(section: SectionId): void;
  onClose(): void;
}

/**
 * 设置视图本体：左栏导航 + 内容区。**替换的是中间三栏**（活动栏 / 侧栏 / 编辑区），
 * 标题栏与状态栏保留 —— 桌面应用不能没有窗口控制按钮。
 *
 * 未实现的分组**可点、可进入**，内容区给空态。让它们点不动（`disabled`）就等于「点了没反应」，
 * 那是比空态更糟的反馈；而把它们从导航里删掉，每加一个分组都要改导航结构。
 */
export const SettingsView: React.FC<SettingsViewProps> = ({
  section,
  onSelectSection,
  onClose
}) => {
  const { t } = useLocale();
  const navRef = useRef<HTMLElement>(null);
  const current = sectionById(section);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 命令面板的 Escape 挂在它自己的输入框上并已 preventDefault —— 别把两层一起关掉。
      if (event.defaultPrevented) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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

        <button
          type="button"
          className="nexus-settings-back"
          data-settings-back=""
          onClick={onClose}
        >
          {t('settings.back')}
        </button>
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
