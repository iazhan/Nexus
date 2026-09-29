import React from 'react';
import { useLocale, useSettingValue } from '../hooks.js';
import { optionLabel, optionsOf, THEME_FIELD } from './registry.js';
import { ThemeEditor } from './ThemeEditor.js';

/**
 * Appearance 分组：主题三态 + 两档主题编辑器。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 系统浅色时选「跟随系统」，解析结果仍是
 * `nexus-light`，若按解析结果判据，「跟随系统」与「Nexus Light」会同时点亮。
 *
 * 选项表走 `optionsOf()`：编辑种子会 fork 出一个用户主题，它必须在选项里出现，否则四项全不勾选。
 *
 * 没有保存按钮（设置项即时生效），也没有「恢复默认」（2026-09-28 定）。
 */
export const AppearanceSection: React.FC = () => {
  const { t } = useLocale();
  const themeChoice = useSettingValue('appearance.theme');
  const label = t(THEME_FIELD.labelKey);
  const options = optionsOf(THEME_FIELD, t);

  return (
    <section className="nexus-settings-section" data-section="appearance">
      <h2 className="nexus-settings-section-title">{t('settings.section.appearance')}</h2>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{label}</span>
        {THEME_FIELD.descriptionKey && (
          <p className="nexus-settings-field-description">{t(THEME_FIELD.descriptionKey)}</p>
        )}

        <div className="nexus-settings-options" role="radiogroup" aria-label={label}>
          {options.map((option) => {
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
                {optionLabel(option, t)}
              </button>
            );
          })}
        </div>
      </div>

      <ThemeEditor />
    </section>
  );
};
