import React, { useMemo, useState } from 'react';
import {
  isUserThemeId,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  type NexusThemeScheme,
  type ThemeMode,
} from '@nexus/theme';
import { AutoIcon, DarkIcon, LightIcon } from '../components/theme-icons.js';
import { themeManager } from '../platform.js';
import { useLocale, useTheme } from '../hooks.js';
import { optionLabel, optionsOf, THEME_MODE_FIELD, THEME_PRESET_FIELD } from './registry.js';
import { modePreviewSchemes, schemesForPreset, swatchForSchemes } from './theme-swatch.js';
import { ThemeEditor } from './ThemeEditor.js';

/**
 * Appearance 分组：**模式 × 预设**两轴 + 两档主题编辑器。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 自动模式下系统是浅色时解析结果是
 * `nexus-light`，按解析结果判据会让「浅色」与「自动」同时点亮。
 *
 * 模式三张卡片画的是**当前预设的真实配色**（缩略图直接取种子，不是画一张示意图）：换预设时
 * 缩略图跟着换，于是「这套主题的浅色长什么样」是看得见的。缩略图本身是**一扇完整的主窗口**
 * （标题栏 / 活动栏 / 侧栏 / 编辑区 / 状态栏），自动模式并排画两扇，先暗后亮。
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

/** 模式 → 标签前的图标。三个一起定义：它们是同一根轴上的三个位置，缺一个就读不出「这是一组」。 */
const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  light: LightIcon,
  auto: AutoIcon,
  dark: DarkIcon
};

/**
 * 选中勾。只有这一处画它，所以留在本文件 —— 见 `components/theme-icons.tsx` 的边界说明。
 * 线宽 3 而不是 2：12px 显示时 24 的 viewBox 缩了一半，线宽 2 只剩 1px，勾会糊。
 */
const CheckIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** 活动栏里的图标点、侧栏的列表项、编辑区的正文行。长短由 CSS 按 `nth-child` 错开。 */
const RAIL_ICONS = [0, 1, 2, 3];
const SIDE_LINES = [0, 1, 2, 3];
const EDITOR_LINES = [0, 1, 2, 3, 4];

/**
 * 缩略图里的一扇**主窗口**。
 *
 * 分区照真窗口来：标题栏 / 活动栏 + 侧栏 + 编辑区 / 状态栏（对应 `.nexus-header-bar`、
 * `.nexus-activity-bar`、`.nexus-activity-panel`、`.nexus-main-content`、`.nexus-status-bar`）。
 * 底色也照它们的 token 语义取种子：`bg-surface` = `base01`（标题栏、侧栏、状态栏），
 * `bg-canvas` = `base00`（活动栏、编辑区），内部分隔线 = `base02`（base16 的「默认边框」槽位）。
 *
 * 所以缩略图是「**这套主题下主窗口长什么样**」，不是一张通用的示意图。活动栏与编辑区同色
 * （真窗口里就是如此），靠中间那条侧栏隔开才分得出来 —— 给它换个颜色反而与真窗口不符。
 *
 * 分隔线用种子而不是 `--nexus-border-*`：那是**被画的窗口**内部的东西，换个主题就得跟着换。
 * 外框与两扇之间的分隔线才用当前主题的 token —— 那些属于这个控件本身。
 */
const MiniWindow: React.FC<{ scheme: NexusThemeScheme }> = ({ scheme }) => {
  const { palette } = scheme;
  const edge = { borderColor: palette.base02 };
  return (
    <span className="nexus-theme-mini" style={{ backgroundColor: palette.base00 }}>
      <span
        className="nexus-theme-mini-titlebar"
        style={{ backgroundColor: palette.base01, ...edge }}
      >
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
      </span>

      <span className="nexus-theme-mini-body">
        <span className="nexus-theme-mini-rail">
          {RAIL_ICONS.map((icon) => (
            <span
              key={icon}
              className="nexus-theme-mini-icon"
              style={{ backgroundColor: palette.base04 }}
            />
          ))}
        </span>
        <span className="nexus-theme-mini-side" style={{ backgroundColor: palette.base01 }}>
          {SIDE_LINES.map((line) => (
            <span
              key={line}
              className="nexus-theme-mini-line"
              style={{ backgroundColor: palette.base03 }}
            />
          ))}
        </span>
        <span className="nexus-theme-mini-editor">
          {/* 第一行画成 Markdown 标题（更亮更宽）：编辑区里全是一样的细线，看起来像任何一款
              编辑器；有一行标题才像「打开着一篇文档」。 */}
          <span className="nexus-theme-mini-heading" style={{ backgroundColor: palette.base05 }} />
          {EDITOR_LINES.map((line) => (
            <span
              key={line}
              className="nexus-theme-mini-line"
              style={{ backgroundColor: palette.base04 }}
            />
          ))}
        </span>
      </span>

      <span
        className="nexus-theme-mini-status"
        style={{ backgroundColor: palette.base01, ...edge }}
      >
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
      </span>
    </span>
  );
};

/**
 * 一张模式卡片的缩略图：一套种子画一扇完整主窗口，两套（自动模式）就是**两扇并排**。
 *
 * 不把一扇切成两半：那会读成「深色的壳配浅色的内容」—— 那是混搭，不是跟随系统。
 * 两扇并排才是「系统亮给你左边这扇，暗给你右边这扇」。
 */
const ModePreview: React.FC<{ schemes: readonly NexusThemeScheme[] }> = ({ schemes }) => (
  <span className="nexus-theme-mode-preview" aria-hidden="true">
    {schemes.map((scheme, index) => (
      <span key={index} className="nexus-theme-mode-pane">
        <MiniWindow scheme={scheme} />
      </span>
    ))}
  </span>
);

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
            const value = option.value as ThemeMode;
            const checked = mode === value;
            // 缩略图取**当前预设**这套主题的真实种子：换预设时它跟着换，「这套主题的浅色长什么样」
            // 于是是看得见的，而不是一张画给所有主题共用的示意图。
            const previews = modePreviewSchemes(activePreset, value, activeUserScheme);
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!modeSwitchable}
                className={`nexus-theme-mode${checked ? ' nexus-theme-mode-active' : ''}`}
                data-theme-mode={value}
                onClick={() => THEME_MODE_FIELD.accessor.write(value)}
              >
                {previews.length > 0 && <ModePreview schemes={previews} />}
                <span className="nexus-theme-mode-label">
                  <span className="nexus-theme-mode-icon" aria-hidden="true">
                    {MODE_ICON[value]}
                  </span>
                  {optionLabel(option, t)}
                </span>
                {/* 勾是「选中」的第二条通道 —— 只靠边框颜色区分的话，色觉障碍用户看不出选了哪一个。 */}
                {checked && (
                  <span className="nexus-theme-mode-check" aria-hidden="true">
                    {CheckIcon}
                  </span>
                )}
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
