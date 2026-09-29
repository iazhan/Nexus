import React, { useMemo, useState } from 'react';
import {
  formatSelection,
  isUserThemeId,
  parseSelection,
  presetOfScheme,
  presetVariantsOf,
  resolveThemeId,
  type ThemeMode,
  type UserTheme
} from '@nexus/theme';
import { AutoIcon, DarkIcon, LightIcon } from '../components/theme-icons.js';
import { duplicateTheme, removeUserTheme, themeManager } from '../platform.js';
import { useLocale, useSettingValue, useTheme } from '../hooks.js';
import { optionLabel, optionsOf, THEME_MODE_FIELD, THEME_PRESET_FIELD } from './registry.js';
import { schemesForPreset } from './theme-preview-schemes.js';
import { ThemeThumbnail } from './ThemeThumbnail.js';
import { ThemeTransfer } from './ThemeTransfer.js';

/**
 * Appearance 分组：**模式 × 预设**两轴，加一个通往主题窗口的入口。
 *
 * 选中态取**选择**（`themeChoice`）而不是解析结果 —— 自动模式下系统是浅色时解析结果是
 * `nexus-light`，按解析结果判据会让「浅色」与「自动」同时点亮。
 *
 * 两轴的卡片都画**当前预设的真实配色**（缩略图直接取种子，不是画一张示意图）：换预设时缩略图
 * 跟着换，于是「这套主题长什么样」是看得见的。缩略图本身是**一扇完整的主窗口**（标题栏 /
 * 活动栏 / 侧栏 / 编辑区 / 状态栏），自动模式并排画两扇，先暗后亮 —— 画法见 `ThemeThumbnail.tsx`。
 *
 * 预设列表走 `optionsOf()`：编辑种子会 fork 出一个用户主题，它必须出现在列表里，否则一个预设
 * 都不勾选。
 *
 * ## 编辑器不在这里，它在自己的窗口里
 *
 * 原先编辑器常驻在本分组底部（显隐由 `themeManager.isEditable` 派生）。搬走的原因是**容器**：
 * 设置窗口内容宽 599px，`@media (max-width: 900px)` 因此命中、预览被折到表单下面，「实时预览」
 * 实际在一屏之外。两栏工作台放不进单列设置页，所以换了容器而不是缩小预览。
 *
 * 于是本分组只留一个入口行（`data-theme-open-window`）。**入口在分组最上面**：它是这一段里唯一
 * 会离开本页的动作，埋在五十多张卡片下面等于没有。
 *
 * 两个造主题的入口（**新建**、每张卡上的**复制**）造完副本会**顺手开窗** —— 这与它们原先的语义
 * 一致（「点了入口才出现编辑器」），只是编辑器换到了另一个窗口里。关掉窗口后想再进去，走那个
 * 入口行。
 *
 * ## 「新建主题」为什么在 radiogroup 外面
 *
 * 预设网格是 `role="radiogroup"`，而它不是一项选择、是个动作。混进去读屏会把它当成第 54 个
 * 选项，且它永远 `aria-checked=false`。所以它是一条独立的动作条，画在网格末尾。
 *
 * 复制键（`data-theme-copy`）是这条规矩的例外：它必须**贴着卡片**才有用，于是与卡片按钮平级地
 * 待在同一个槽位里 —— 严格按 ARIA，radiogroup 里不该有非 radio 子项。代价是读屏会在这个组里
 * 多念到若干「复制」按钮，收益是每张卡都有一个可聚焦、可点、有名字的复制入口。若日后要清零这
 * 条，把复制挪进卡片的右键菜单即可。
 *
 * 描述只画**当前预设**那一条，不画在每张卡上：五十多个预设里只有少数写了描述，逐卡画会让网格
 * 高度参差。卡片本身只用名字与缩略图说话。
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

/** 复制键、新建条、删除键各用一枚，都只有一处用 —— 按 `theme-icons.tsx` 的边界留在调用方。 */
const CopyIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const TrashIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M6 6v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6" />
  </svg>
);

const EditIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const PlusIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/** 入口行右侧那枚「开新窗」提示。与「复制」不同：它不造东西，只是换个地方看。 */
const OpenIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/**
 * 一张卡对应哪一套**方案**：预设要按当前模式解析到明暗某一版，用户主题自己就是那一版。
 *
 * 源必须是方案 id 而不是预设 id —— 预设的明暗两版是两套方案，而用户主题只装得下一版。
 * `resolveThemeId` 自带单变体回落（另一边没有就退回它有的那版），不用在这里再判一次。
 */
function schemeIdForCard(cardId: string, mode: ThemeMode): string {
  if (isUserThemeId(cardId)) return cardId;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return resolveThemeId(formatSelection({ preset: cardId, mode }), prefersDark);
}

export const AppearanceSection: React.FC = () => {
  const { t, has } = useLocale();
  // 用 `useTheme` 而不是 `useSettingValue`：它除了给「选择」（选中态的判据），还订阅了
  // `themeManager` —— 另一个窗口里改了主题，这里的卡片要跟着变。
  const { themeChoice } = useTheme();
  const [query, setQuery] = useState('');

  const selection = parseSelection(themeChoice);
  const activePreset = 'preset' in selection ? selection.preset : selection.id;
  // 裸方案 id（用户主题）没有模式轴，显示它自己的明暗即可 —— 控件本来也是禁用的。
  const mode: ThemeMode =
    'preset' in selection
      ? selection.mode
      : (presetOfScheme(selection.id)?.mode ?? themeManager.theme.type);
  const variants = presetVariantsOf(activePreset) ?? themeManager.userVariantsOf(activePreset);
  const modeSwitchable = Boolean(variants?.light && variants?.dark);

  /** 当前是不是在编辑一套自定义主题。只用来选入口行的说明文案与模式锁定的理由。 */
  const editing = themeManager.isEditable;

  /**
   * 用户主题那类卡片要画的种子。**优先取当前解析到的那份**（主题窗口里刚拖过色，它是最新的），
   * 其次是存档里那份 —— 切到内置预设之后 `activeUserTheme` 是 `null`，而用户主题仍然列在
   * 列表里，不兜这一下它的卡片会是一张空白缩略图。
   *
   * 整份 `UserTheme` 都要：它明暗两版共用 id，只给一版的话自动模式下画不出两扇窗。
   * 列表里可能有好几套，所以**按 id 取**，不是取「那一份」。
   */
  const savedUserThemes = useSettingValue('appearance.userThemes');
  const userThemeFor = (id: string): UserTheme | null =>
    (themeManager.activeUserTheme?.id === id ? themeManager.activeUserTheme : null) ??
    savedUserThemes.find((theme) => theme.id === id) ??
    null;

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

  /** 主题窗口是单例，重复点只会聚焦已经开着的那个 —— 这里不需要自己判重。 */
  const openEditor = (): void => {
    void window.nexus?.openThemeWindow?.();
  };

  /** 造一份以 `sourceSchemeId` 为起点的副本，切过去，然后进编辑器 —— 一步到「可以开始改」。 */
  const duplicateAndEdit = (sourceSchemeId: string): void => {
    if (duplicateTheme(sourceSchemeId)) openEditor();
  };

  /**
   * 「编辑这套主题」：先**切过去**再开窗。
   *
   * 编辑器改的永远是**当前主题**（它的显隐判据就是「当前主题是用户主题」），所以不先切过去的话
   * 开出来的是另一套 —— 用户点的是这张卡上的键，期待改的就是这一套。
   */
  const editTheme = (presetId: string): void => {
    THEME_PRESET_FIELD.accessor.write(presetId);
    openEditor();
  };

  return (
    <section className="nexus-settings-section" data-section="appearance">
      <h2 className="nexus-settings-section-title">{t('settings.section.appearance')}</h2>

      {/* 入口行放最上面：它是本段唯一会离开这一页的动作，压到五十多张卡片下面等于藏起来。 */}
      <div className="nexus-theme-open" data-theme-open="">
        <div className="nexus-theme-open-text">
          <span className="nexus-theme-open-title">{t('theme.editor.title')}</span>
          <span className="nexus-theme-open-desc">
            {t(editing ? 'theme.editor.description' : 'theme.editor.forkHint')}
          </span>
        </div>
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-open-window=""
          onClick={openEditor}
        >
          <span className="nexus-theme-open-icon" aria-hidden="true">
            {OpenIcon}
          </span>
          {t('theme.open.action')}
        </button>
      </div>

      <div className="nexus-settings-field">
        <span className="nexus-settings-field-label">{modeLabel}</span>
        <div className="nexus-theme-modes" role="radiogroup" aria-label={modeLabel}>
          {(THEME_MODE_FIELD.options ?? []).map((option) => {
            const value = option.value as ThemeMode;
            const checked = mode === value;
            // 缩略图取**当前预设**这套主题的真实种子：换预设时它跟着换，「这套主题的浅色长什么样」
            // 于是是看得见的，而不是一张画给所有主题共用的示意图。
            const previews = schemesForPreset(activePreset, value, userThemeFor(activePreset));
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
                {previews.length > 0 && <ThemeThumbnail schemes={previews} size="mode" />}
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
            {/* 理由要分清是**当前这套**哪一类：用户主题与「上游只出一版」的预设都换不了模式，
                但把后者那句挂到自定义主题上等于把责任推给一个不存在的上游。 */}
            {t(editing ? 'theme.modeUnavailable.custom' : MODE_LOCKED_KEY)}
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

        <div
          className="nexus-theme-cards"
          role="radiogroup"
          aria-label={t(THEME_PRESET_FIELD.labelKey)}
        >
          {shown.map((option) => {
            const checked = activePreset === option.value;
            // 自动模式下这套预设没有单一配色，缩略图画两扇窗（先暗后亮）—— 见 `theme-preview-schemes.ts`。
            const schemes = schemesForPreset(
              option.value,
              mode,
              isUserThemeId(option.value) ? userThemeFor(option.value) : null
            );
            return (
              <div className="nexus-theme-card-slot" key={option.value}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className={`nexus-theme-card${checked ? ' nexus-theme-card-active' : ''}`}
                  data-theme-option={option.value}
                  onClick={() => THEME_PRESET_FIELD.accessor.write(option.value)}
                >
                  {schemes.length > 0 && (
                    // 缩略图纯装饰：颜色是主题数据，读屏读不出信息，名字才是。
                    <ThemeThumbnail schemes={schemes} size="card" />
                  )}
                  <span className="nexus-theme-card-name">{optionLabel(option, t)}</span>
                </button>
                <div className="nexus-theme-card-actions">
                  {/* 编辑键只在**用户主题**的卡片上。内置主题不可写 —— 改它要先复制，而复制键干
                      的正是这件事（而且复制完直接进编辑器），所以给它一枚「编辑」只会让人以为
                      改得动内置主题。 */}
                  {isUserThemeId(option.value) && (
                    <button
                      type="button"
                      className="nexus-theme-card-action"
                      data-theme-edit={option.value}
                      title={t('theme.edit')}
                      aria-label={`${t('theme.edit')} · ${optionLabel(option, t)}`}
                      onClick={() => editTheme(option.value)}
                    >
                      {EditIcon}
                    </button>
                  )}
                  <button
                    type="button"
                    className="nexus-theme-card-action"
                    data-theme-copy={option.value}
                    title={t('theme.copy')}
                    aria-label={`${t('theme.copy')} · ${optionLabel(option, t)}`}
                    onClick={() => duplicateAndEdit(schemeIdForCard(option.value, mode))}
                  >
                    {CopyIcon}
                  </button>
                  {/* 只有用户主题能删 —— 内置主题删掉就是「把它从出厂表里拿掉」，做不到也不该做。 */}
                  {isUserThemeId(option.value) && (
                    <button
                      type="button"
                      className="nexus-theme-card-action nexus-theme-card-delete"
                      data-theme-delete={option.value}
                      title={t('theme.delete.action')}
                      aria-label={`${t('theme.delete.action')} · ${optionLabel(option, t)}`}
                      onClick={() => removeUserTheme(option.value)}
                    >
                      {TrashIcon}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 动作条不进 `shown`：搜不到主题时它更该在，而不是跟着空态一起消失。 */}
        <button
          type="button"
          className="nexus-theme-card-new"
          data-theme-new=""
          onClick={() => duplicateAndEdit(themeManager.theme.id)}
        >
          <span className="nexus-theme-card-new-icon" aria-hidden="true">
            {PlusIcon}
          </span>
          {t('theme.new')}
        </button>

        {shown.length === 0 && (
          <p className="nexus-settings-field-description" data-theme-search-empty>
            {t('theme.searchEmpty')}
          </p>
        )}
      </div>

      {/* 导入 / 导出与「在不在编辑一套自定义主题」无关：导出内置主题同样要能用，导入进来也照样
          在设置页里挑。它不进主题窗口 —— 那个窗口可能正开在一套内置主题上（只读），
          文件投放区不该跟着只读。 */}
      <ThemeTransfer />
    </section>
  );
};
