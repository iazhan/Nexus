import React, { useMemo, useState } from 'react';
import {
  isUserThemeId,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  type ThemeMode,
} from '@nexus/theme';
import { themeManager } from '../platform.js';
import { useLocale, useTheme } from '../hooks.js';
import { optionLabel, optionsOf, THEME_MODE_FIELD, THEME_PRESET_FIELD } from './registry.js';
import { schemesForPreset, swatchForSchemes } from './theme-swatch.js';
import { ThemeEditor } from './ThemeEditor.js';

/**
 * Appearance 分组：**模式 × 预设**两轴 + 两档主题编辑器。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 自动模式下系统是浅色时解析结果是
 * `nexus-light`，按解析结果判据会让「浅色」与「自动」同时点亮。
 *
 * 预设列表走 `optionsOf()`：编辑种子会 fork 出一个用户主题，它必须出现在列表里，否则一个预设
 * 都不勾选。
 *
 * 描述只画**当前预设**那一条，不画在每张卡上：五十多个预设里只有少数写了描述，逐卡画会让网格
 * 高度参差。卡片本身只用名字与配色说话。
 *
 * 没有保存按钮（设置项即时生效），也没有「恢复默认」（2026-09-28 定）。
 */

/** 单变体预设（上游只有一版）没有模式可换，控件禁用并把原因说出来。 */
const MODE_LOCKED_KEY = 'theme.modeUnavailable';

export const AppearanceSection: React.FC = () => {
  const { t, has } = useLocale();
  // 用 `useTheme` 而不是 `useSettingValue`：它除了给「选择」（选中态的判据），还订阅了
  // `themeManager` —— 用户主题的种子在下面的编辑器里被拖色时，卡片上的圆点与色阶要跟着变。
  const { themeChoice } = useTheme();
  const [query, setQuery] = useState('');

  const selection = parseSelection(themeChoice);
  const activePreset = 'preset' in selection ? selection.preset : selection.id;
  // 裸方案 id（用户主题）没有模式轴，显示它自己的明暗即可 —— 控件本来也是禁用的。
  const mode: ThemeMode =
    'preset' in selection
      ? selection.mode
      : (presetOfScheme(selection.id)?.mode ?? themeManager.theme.type);
  const variants = presetVariantsOf(activePreset);
  const modeSwitchable = Boolean(variants?.light && variants?.dark);
  const activeUserScheme = themeManager.activeUserTheme?.scheme ?? null;

  const options = optionsOf(THEME_PRESET_FIELD, t);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle === ''
        ? options
        : options.filter((option) => optionLabel(option, t).toLowerCase().includes(needle)),
    [options, needle, t]
  );

  const descriptionKey = isUserThemeId(activePreset)
    ? 'theme.description.custom'
    : `theme.description.${activePreset}`;

  const modeLabel = t(THEME_MODE_FIELD.labelKey);

  return (
    <section className="nexus-settings-section" data-section="appearance">
      <h2 className="nexus-settings-section-title">{t('settings.section.appearance')}</h2>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{modeLabel}</span>
        <div className="nexus-theme-modes" role="radiogroup" aria-label={modeLabel}>
          {(THEME_MODE_FIELD.options ?? []).map((option) => {
            const checked = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!modeSwitchable}
                className={`nexus-theme-mode${checked ? ' nexus-theme-mode-active' : ''}`}
                data-theme-mode={option.value}
                onClick={() => THEME_MODE_FIELD.accessor.write(option.value)}
              >
                {optionLabel(option, t)}
              </button>
            );
          })}
        </div>
        {!modeSwitchable && (
          <p className="nexus-settings-field-description" data-mode-locked>
            {t(MODE_LOCKED_KEY)}
          </p>
        )}
      </div>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{t(THEME_PRESET_FIELD.labelKey)}</span>

        <input
          type="search"
          className="nexus-theme-search"
          value={query}
          placeholder={t('theme.searchPlaceholder')}
          aria-label={t('theme.searchPlaceholder')}
          data-theme-search
          onChange={(event) => setQuery(event.target.value)}
        />

        {has(descriptionKey) && (
          <p className="nexus-settings-field-description" data-preset-description>
            {t(descriptionKey)}
          </p>
        )}

        <div className="nexus-theme-cards" role="radiogroup" aria-label={t(THEME_PRESET_FIELD.labelKey)}>
          {shown.map((option) => {
            const checked = activePreset === option.value;
            // 自动模式下这套预设没有单一配色，圆点画两半、条画八段 —— 见 `theme-swatch.ts`。
            const swatch = swatchForSchemes(
              schemesForPreset(
                option.value,
                mode,
                isUserThemeId(option.value) ? activeUserScheme : null
              )
            );
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`nexus-theme-card${checked ? ' nexus-theme-card-active' : ''}`}
                data-theme-option={option.value}
                onClick={() => THEME_PRESET_FIELD.accessor.write(option.value)}
              >
                {swatch && (
                  // 色块纯装饰：颜色是主题数据，读屏读不出信息，名字才是。
                  <span className="nexus-theme-card-head" aria-hidden="true">
                    <span className="nexus-theme-card-dot">
                      {swatch.dot.map((color, index) => (
                        <span
                          key={index}
                          className="nexus-theme-card-half"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </span>
                    <span className="nexus-theme-card-strip">
                      {swatch.strip.map((color, index) => (
                        <span
                          key={index}
                          className="nexus-theme-card-segment"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </span>
                  </span>
                )}
                <span className="nexus-theme-card-name">{optionLabel(option, t)}</span>
              </button>
            );
          })}
        </div>

        {shown.length === 0 && (
          <p className="nexus-settings-field-description" data-theme-search-empty>
            {t('theme.searchEmpty')}
          </p>
        )}
      </div>

      <ThemeEditor />
    </section>
  );
};
