import React from 'react';
import { useLocale, useSettingValue } from '../hooks.js';
import { THEME_FIELD } from './registry.js';

/**
 * Appearance 分组：本期唯一有内容的分组。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 系统浅色时选「跟随系统」，解析结果仍是
 * `nexus-light`，若按解析结果判据，「跟随系统」与「Nexus Light」会同时点亮。
 *
 * 没有保存按钮（设置项即时生效），也没有「恢复默认」（2026-09-28 定）。
 */
export const AppearanceSection: React.FC = () => {
  const { t } = useLocale();
  const themeChoice = useSettingValue('appearance.theme');
  const label = t(THEME_FIELD.labelKey);

  return (
    <section className="nexus-settings-section" data-section="appearance">
      <h2 className="nexus-settings-section-title">{t('settings.section.appearance')}</h2>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{label}</span>
        {THEME_FIELD.descriptionKey && (
          <p className="nexus-settings-field-description">{t(THEME_FIELD.descriptionKey)}</p>
        )}

        <div className="nexus-settings-options" role="radiogroup" aria-label={label}>
          {(THEME_FIELD.options ?? []).map((option) => {
            const checked = themeChoice === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`nexus-settings-option${checked ? ' nexus-settings-option-active' : ''}`}
                data-theme-option={option.value}
                onClick={() => THEME_FIELD.accessor.write(option.value)}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
