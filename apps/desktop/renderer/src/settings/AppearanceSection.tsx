import React from 'react';
import { isUserThemeId } from '@nexus/theme';
import { themeManager } from '../platform.js';
import { useLocale, useTheme } from '../hooks.js';
import { optionLabel, optionsOf, THEME_FIELD } from './registry.js';
import { swatchFor } from './theme-swatch.js';
import { ThemeEditor } from './ThemeEditor.js';

/**
 * Appearance 分组：主题卡片 + 两档主题编辑器。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 系统浅色时选「跟随系统」，解析结果仍是
 * `nexus-light`，若按解析结果判据，「跟随系统」与「Nexus Light」会同时点亮。
 *
 * 选项表走 `optionsOf()`：编辑种子会 fork 出一个用户主题，它必须在选项里出现，否则四项全不勾选。
 *
 * 没有保存按钮（设置项即时生效），也没有「恢复默认」（2026-09-28 定）。
 */

/**
 * 一句话描述。**键名里带主题 id**，所以「没写描述」是正常状态、不是错误 —— 用户主题与将来新增的
 * 出厂主题都可能没有，这时整行不画。缺键时 `t()` 会把键名原样返回，所以必须先问 `has()`。
 */
function descriptionFor(
  value: string,
  t: (key: string) => string,
  has: (key: string) => boolean
): string | undefined {
  const key = isUserThemeId(value) ? 'theme.description.custom' : `theme.description.${value}`;
  return has(key) ? t(key) : undefined;
}

export const AppearanceSection: React.FC = () => {
  const { t, has } = useLocale();
  // 用 `useTheme` 而不是 `useSettingValue`：它除了给「选择」（选中态的判据），还订阅了
  // `themeManager` —— 用户主题的种子在下面的编辑器里被拖色时，卡片上的圆点与色阶要跟着变。
  const { themeChoice } = useTheme();
  const label = t(THEME_FIELD.labelKey);
  const options = optionsOf(THEME_FIELD, t);
  const activeUserScheme = themeManager.activeUserTheme?.scheme ?? null;

  return (
    <section className="nexus-settings-section" data-section="appearance">
      <h2 className="nexus-settings-section-title">{t('settings.section.appearance')}</h2>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{label}</span>
        {THEME_FIELD.descriptionKey && (
          <p className="nexus-settings-field-description">{t(THEME_FIELD.descriptionKey)}</p>
        )}

        <div className="nexus-theme-cards" role="radiogroup" aria-label={label}>
          {options.map((option) => {
            const checked = themeChoice === option.value;
            const swatch = swatchFor(option.value, activeUserScheme);
            const description = descriptionFor(option.value, t, has);
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`nexus-theme-card${checked ? ' nexus-theme-card-active' : ''}`}
                data-theme-option={option.value}
                onClick={() => THEME_FIELD.accessor.write(option.value)}
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
                {description && (
                  <span className="nexus-theme-card-description">{description}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ThemeEditor />
    </section>
  );
};
