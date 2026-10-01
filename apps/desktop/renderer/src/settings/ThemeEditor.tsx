import React, { useEffect, useMemo, useState } from 'react';
import {
  defaultTuning,
  formatSelection,
  measureTheme,
  seedsToTokensWithReport,
  type Base16Slot,
  type ContrastFailure,
  type Tuning
} from '@nexus/theme';
import {
  applyOverrides,
  applySchemePatch,
  applyThemeChoice,
  duplicateTheme,
  themeManager
} from '../platform.js';
import { useLocale, useTheme } from '../hooks.js';
import { Dialog } from '../components/Dialog.js';
import {
  COLOUR_FALLBACK,
  SEED_GROUPS,
  SLOT_ROLE_KEYS,
  TOKEN_GROUPS,
  TUNING_FIELDS,
  toColorInputValue
} from './theme-fields.js';
import { ThemePreview } from './ThemePreview.js';
import { Base16PasteBox } from './Base16PasteBox.js';
import { ThemeMergePrompt } from './ThemeMergePrompt.js';

/**
 * 主题编辑器：**左栏改参数、右栏看结果**，是主题窗口（`?window=theme`）的根内容。
 *
 * 两栏不是排版偏好，是这次从设置页搬出来的原因。它原先挤在设置页的单列里，实测设置窗口内容宽
 * 599px，`@media (max-width: 900px)` 因此命中、预览被折到表单**下面** —— 拖一个取色器时预览在
 * 一屏之外，「实时预览」等于没有。宽度问题不能在窄容器里解决，所以换了容器。
 *
 * 三件界面上必须成立的事：
 *
 * - **改了什么 vs 结果是什么分开**。种子 / 系数 / token 是输入，派生修正记录、对比度体检、
 *   预览是输出。原先它们上下串在一条流里，输出被埋在输入的最下面。
 * - **高级档动过的项切回基础档不能静默消失**：基础档顶部常驻一条「有 N 项自定义覆盖」+ 查看入口。
 * - **修正要说出来**：派生档列出哪些 token 被自动修正过、从多少修到多少；高级档对不达标的覆盖项
 *   标出实际比值与目标比值。只修正不说，用户不知道自己改的种子被动了；只说不修正，用户会存下
 *   一个不可读的主题。
 *
 * **内置主题只读**，此时左栏换成一句说明加一个「复制并开始编辑」。这是常态而不是异常 —— 默认
 * 主题就是内置的，打开窗口先看到只读态才正常；反过来「一打开就替你造一份副本」会让看一眼
 * 编辑器都留下垃圾主题。
 *
 * 预览必须是真组件（见 `ThemePreview.tsx`）。导入 / 导出不在这里：它与「在不在编辑一套自定义
 * 主题」无关，留在设置页常驻。
 */

type Tier = 'basic' | 'advanced';

const SeedPicker: React.FC<{
  slot: Base16Slot;
  value: string;
  roleLabel: string;
  onChange(value: string): void;
}> = ({ slot, value, roleLabel, onChange }) => (
  <label className="nexus-theme-seed">
    <input
      type="color"
      className="nexus-theme-seed-input"
      value={toColorInputValue(value)}
      data-theme-seed={slot}
      onChange={(event) => onChange(event.target.value)}
    />
    <span className="nexus-theme-seed-name">{slot}</span>
    <span className="nexus-theme-seed-role">{roleLabel}</span>
  </label>
);

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

export const ThemeEditor: React.FC = () => {
  const { t } = useLocale();
  // `resolvedTheme` 的引用每次重解析都换，用它当依赖就够 —— 改种子与改覆盖项都会走到这里。
  const { resolvedTheme } = useTheme();
  const [tier, setTier] = useState<Tier>('basic');
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [tokenQuery, setTokenQuery] = useState('');

  const scheme = themeManager.activeScheme;
  const overrides = themeManager.overrides;
  const overrideCount = Object.keys(overrides).length;
  const editable = themeManager.isEditable;
  const themeId = themeManager.theme.id;

  /** 正在编辑的是哪一版。用户主题取当前变体，内置主题取解析结果。 */
  const activeVariant = scheme?.variant ?? resolvedTheme.type;
  /** 两版都有才画切换器。单边主题（从单变体预设复制来的）只有一行文本。 */
  const variants = themeManager.userVariantsOf(themeId);
  const switchable = editable && Boolean(variants?.light && variants?.dark);

  /**
   * 名字输入框是**非受控提交**：草稿留在本地，blur / Enter 才写盘。
   *
   * 不能每次按键都写 —— 中途的空串会被 `parseUserTheme` 拒收，用户删光重打的那一瞬间就把主题
   * 写坏了。回灌的依赖是 `themeId + 当前名字`：切主题要跟着换，提交后要把首尾空白归一化；
   * 而打字期间这两个都不变，所以不会把用户正在输入的内容冲掉。
   */
  const currentName = scheme?.name ?? '';
  const [nameDraft, setNameDraft] = useState(currentName);
  useEffect(() => {
    setNameDraft(currentName);
  }, [themeId, currentName]);

  const commitName = (): void => {
    const next = nameDraft.trim();
    // 空名还原不写盘（`patchScheme` 也会挡，但这里要负责把输入框恢复成合法值）。
    if (next === '' || next === currentName) {
      setNameDraft(currentName);
      return;
    }
    applySchemePatch({ name: next });
  };

  const onNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      return;
    }
    if (event.key !== 'Escape') return;
    // 还原后**必须失焦**：窗口级的 Escape 关窗挂在 `defaultPrevented` 之后，这里不放开焦点的话
    // 每次 Escape 都被输入框吃掉，窗口再也关不掉。
    event.preventDefault();
    setNameDraft(currentName);
    event.currentTarget.blur();
  };

  // 修正记录来自**不带覆盖项**的派生：覆盖项是用户手写的值，不在「自动修正」的范围内。
  const report = useMemo(
    () => (scheme ? seedsToTokensWithReport(scheme) : null),
    [scheme, resolvedTheme]
  );

  const contrast = useMemo(() => measureTheme(resolvedTheme.tokens), [resolvedTheme]);

  // 不达标的配对按 token 归并 —— 一个 token 可能同时落在好几个承载面上，逐行只报最差的那一对。
  const failuresByToken = useMemo(() => {
    const map = new Map<string, ContrastFailure[]>();
    for (const failure of contrast.failures) {
      const list = map.get(failure.token);
      if (list) list.push(failure);
      else map.set(failure.token, [failure]);
    }
    return map;
  }, [contrast]);

  const palette = scheme?.palette;
  const tuning: Required<Tuning> | null = scheme
    ? { ...defaultTuning(scheme.variant), ...scheme.tuning }
    : null;

  const needle = tokenQuery.trim().toLowerCase();
  const visibleTokenGroups = useMemo(
    () =>
      needle === ''
        ? TOKEN_GROUPS
        : TOKEN_GROUPS.map((group) => ({
            ...group,
            tokens: group.tokens.filter((token) => token.toLowerCase().includes(needle))
          })).filter((group) => group.tokens.length > 0),
    [needle]
  );
  const tokenHits = visibleTokenGroups.reduce((count, group) => count + group.tokens.length, 0);

  /** 新建一份以当前主题为起点的副本并切过去。只读态下它就是「开始编辑」那一步。 */
  const copyCurrent = (): void => {
    duplicateTheme(themeManager.theme.id);
  };

  return (
    <div className="nexus-theme-editor" data-theme-editor="">
      <header className="nexus-theme-source" data-theme-source="">
        <div className="nexus-theme-source-info">
          {/* 名字是**从源复制过来的**（fork 不改 name），所以可编辑态下它是一个输入框 —— 改名
              就在原地发生，改完立刻反映到设置页那份预设列表（它读的是同一个 `scheme.name`）。
              只读态退回纯文本：内置主题没有「名字」这回事。 */}
          {editable ? (
            <input
              type="text"
              className="nexus-theme-source-input"
              value={nameDraft}
              aria-label={t('theme.name.label')}
              data-theme-name-input=""
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={onNameKeyDown}
            />
          ) : (
            <span className="nexus-theme-source-name" data-theme-source-name="">
              {scheme?.name ?? t('theme.custom')}
            </span>
          )}
          <div className="nexus-theme-source-meta">
            {/* 明暗两版是**同一套主题**的两面，所以切换器就在名字底下 —— 切它等于切整个应用的模式，
                于是左栏的种子、右栏的预览、主窗口同时换过去，看到哪一版就是在改哪一版。
                单边主题（从单变体预设复制来的）没有另一边可切，退回一行纯文本。 */}
            {editable && switchable ? (
              <div
                className="nexus-theme-variant"
                role="radiogroup"
                aria-label={t('theme.variant.label')}
              >
                {(['light', 'dark'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={activeVariant === value}
                    className={`nexus-theme-variant-option${
                      activeVariant === value ? ' nexus-theme-variant-option-active' : ''
                    }`}
                    data-theme-variant={value}
                    onClick={() => applyThemeChoice(formatSelection({ preset: themeId, mode: value }))}
                  >
                    {t(`theme.mode.${value}`)}
                  </button>
                ))}
              </div>
            ) : (
              <span className="nexus-theme-source-variant" data-theme-source-variant="">
                {t(`theme.mode.${activeVariant}`)}
              </span>
            )}
            {editable && <span className="nexus-theme-source-tag">{t('theme.custom')}</span>}
          </div>
        </div>

        {/* 只读态的「开始编辑」按钮在左栏空态里 —— 那才是它该出现的位置。 */}
        {editable && (
          <button
            type="button"
            className="nexus-theme-action"
            data-theme-copy-current=""
            onClick={copyCurrent}
          >
            {CopyIcon}
            {t('theme.copy')}
          </button>
        )}
      </header>

      <div className="nexus-theme-workbench">
        <div className="nexus-theme-inputs">
          {editable ? (
            <>
              <div className="nexus-theme-inputs-head">
                <div className="nexus-theme-tier" role="tablist" aria-label={t('theme.editor.title')}>
                  {(['basic', 'advanced'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tier === id}
                      className={`nexus-settings-option${tier === id ? ' nexus-settings-option-active' : ''}`}
                      data-theme-tier={id}
                      onClick={() => setTier(id)}
                    >
                      {t(`theme.tier.${id}`)}
                    </button>
                  ))}
                </div>

                {/* 44 个 token 分五组铺开，不搜就只能滚。基础档只有 21 个控件，分组标题够用。 */}
                {tier === 'advanced' && (
                  <input
                    type="search"
                    className="nexus-theme-token-search"
                    value={tokenQuery}
                    placeholder={t('theme.tokenSearchPlaceholder')}
                    aria-label={t('theme.tokenSearchPlaceholder')}
                    data-theme-token-search=""
                    onChange={(event) => setTokenQuery(event.target.value)}
                  />
                )}
              </div>

              {/* 高级档动过的项，切回基础档必须看得见 —— 否则那些覆盖项在界面上等于不存在。 */}
              {overrideCount > 0 && (
                <div className="nexus-theme-override-banner" data-override-banner={overrideCount}>
                  <span className="nexus-theme-override-text">
                    {t('theme.overrides.banner', { count: String(overrideCount) })}
                  </span>
                  <button
                    type="button"
                    className="nexus-theme-link"
                    data-override-view=""
                    onClick={() => setOverridesOpen(true)}
                  >
                    {t('theme.overrides.view')}
                  </button>
                  <button
                    type="button"
                    className="nexus-theme-link"
                    data-override-clear-all=""
                    onClick={() =>
                      applyOverrides(Object.fromEntries(Object.keys(overrides).map((k) => [k, null])))
                    }
                  >
                    {t('theme.overrides.clear')}
                  </button>
                </div>
              )}

              {tier === 'basic' ? (
                <div className="nexus-theme-basic" data-theme-tier-panel="basic">
                  {SEED_GROUPS.map((group) => (
                    <section className="nexus-theme-seeds" key={group.id} data-theme-seed-group={group.id}>
                      <h3 className="nexus-theme-group-title">{t(group.labelKey)}</h3>
                      <div className="nexus-theme-seed-grid">
                        {group.slots.map((slot) => (
                          <SeedPicker
                            key={slot}
                            slot={slot}
                            value={palette?.[slot] ?? COLOUR_FALLBACK}
                            roleLabel={t(SLOT_ROLE_KEYS[slot])}
                            onChange={(value) => applySchemePatch({ palette: { [slot]: value } })}
                          />
                        ))}
                      </div>
                    </section>
                  ))}

                  {tuning && (
                    <section className="nexus-theme-tuning" data-theme-tuning-group="">
                      <h3 className="nexus-theme-group-title">{t('theme.tuning.title')}</h3>
                      {/* 「层级」是个自造词，不解释就等于五个没有含义的滑块 —— 它们不是颜色，
                          是派生系数（0 = 贴底色，1 = 完全变对照色）。 */}
                      <p className="nexus-settings-field-description" data-theme-tuning-hint="">
                        {t('theme.tuning.description')}
                      </p>
                      {TUNING_FIELDS.map((field) => (
                        <label className="nexus-theme-tuning-row" key={field.key}>
                          <span className="nexus-theme-tuning-label">{t(field.labelKey)}</span>
                          <input
                            type="range"
                            className="nexus-theme-tuning-input"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={tuning[field.key]}
                            data-theme-tuning={field.key}
                            onChange={(event) =>
                              applySchemePatch({ tuning: { [field.key]: Number(event.target.value) } })
                            }
                          />
                          <span className="nexus-theme-tuning-value">{tuning[field.key].toFixed(2)}</span>
                        </label>
                      ))}
                    </section>
                  )}

                  {/* 粘贴框就放在 16 个取色器下面 —— 它干的是同一件事（换掉那 16 个种子），
                      只是用一段文本代替逐个拖。放在「层级系数」之后是因为它更"重"：一次换掉
                      整套配色，不该挤在种子网格中间。 */}
                  <Base16PasteBox />
                  <ThemeMergePrompt />
                </div>
              ) : (
                <div className="nexus-theme-advanced" data-theme-tier-panel="advanced">
                  {visibleTokenGroups.map((group) => (
                    <section className="nexus-theme-tokens" key={group.id} data-theme-token-group={group.id}>
                      <h3 className="nexus-theme-group-title">{t(group.labelKey)}</h3>
                      {group.tokens.map((token) => {
                        const value = resolvedTheme.tokens[token] ?? COLOUR_FALLBACK;
                        const overridden = token in overrides;
                        const worst = failuresByToken.get(token)?.[0];
                        return (
                          <div
                            className="nexus-theme-token"
                            key={token}
                            data-theme-token={token}
                            data-overridden={overridden}
                          >
                            <input
                              type="color"
                              className="nexus-theme-token-input"
                              value={toColorInputValue(value)}
                              data-theme-token-input={token}
                              onChange={(event) => applyOverrides({ [token]: event.target.value })}
                            />
                            <code className="nexus-theme-token-name">{token}</code>
                            {/* 覆盖项与派生值要能一眼分开：改过的那行左边加一道竖线，名字下面写清
                                当前这个值是自己写的还是算出来的。 */}
                            <span
                              className="nexus-theme-token-state"
                              data-token-state={overridden ? 'overridden' : 'derived'}
                            >
                              {t(overridden ? 'theme.tokenState.overridden' : 'theme.tokenState.derived')}
                            </span>
                            {worst && (
                              <span className="nexus-theme-token-contrast" data-contrast="fail">
                                {t('theme.contrast.failing', {
                                  ratio: worst.ratio.toFixed(2),
                                  target: String(worst.threshold)
                                })}
                              </span>
                            )}
                            {overridden && (
                              <button
                                type="button"
                                className="nexus-theme-link"
                                data-theme-token-reset={token}
                                onClick={() => applyOverrides({ [token]: null })}
                              >
                                {t('theme.resetToken')}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  ))}

                  {tokenHits === 0 && (
                    <p className="nexus-settings-field-description" data-theme-token-search-empty="">
                      {t('theme.tokenSearchEmpty')}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="nexus-theme-readonly" data-theme-readonly="">
              <h3 className="nexus-theme-group-title">{t('theme.source.readonly')}</h3>
              <p className="nexus-settings-field-description">{t('theme.editor.forkHint')}</p>
              <button
                type="button"
                className="nexus-theme-action nexus-theme-action-primary"
                data-theme-fork=""
                onClick={copyCurrent}
              >
                {CopyIcon}
                {t('theme.source.fork')}
              </button>
            </div>
          )}
        </div>

        {/* 右栏是**结果**：派生修正、对比度体检、真组件预览。改动一发生它整列都在同一屏里。 */}
        <div className="nexus-theme-results">
          <ThemePreview />

          <section
            className="nexus-theme-verdict"
            data-theme-contrast-panel={contrast.failures.length}
            aria-label={t('theme.contrast.title')}
          >
            <h3 className="nexus-theme-group-title">{t('theme.contrast.title')}</h3>
            {contrast.failures.length === 0 ? (
              <p className="nexus-theme-verdict-ok" data-contrast-verdict="ok">
                {t('theme.contrast.ok')}
              </p>
            ) : (
              <>
                <p className="nexus-theme-verdict-bad" data-contrast-verdict="fail">
                  {t('theme.contrast.summary', { count: String(contrast.failures.length) })}
                </p>
                <ul className="nexus-theme-verdict-list">
                  {contrast.failures.map((failure) => (
                    <li key={`${failure.token}@${failure.ground}`} data-contrast-pair={failure.token}>
                      <code className="nexus-theme-token-name">{failure.token}</code>
                      <span className="nexus-theme-verdict-on">
                        {t('theme.contrast.on', { ground: failure.ground })}
                      </span>
                      <span className="nexus-theme-verdict-ratio">
                        {failure.ratio.toFixed(2)}:1
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {report && report.corrections.length > 0 && (
            <section
              className="nexus-theme-corrections"
              data-corrections={report.corrections.length}
            >
              <h3 className="nexus-theme-group-title">
                {t('theme.corrections.title', { count: String(report.corrections.length) })}
              </h3>
              <p className="nexus-settings-field-description">{t('theme.corrections.description')}</p>
              <ul className="nexus-theme-corrections-list">
                {report.corrections.map((correction) => {
                  // 「目标值」只在**没够到**时才印。`atRatio` 到达目标就跳出，所以成功的那些
                  // `to >= target` 必然成立 —— 而它们的目标大多是同一个常数（文字 4.5 / 图形 3），
                  // 逐行印出来只是一列重复的数字。没够到的那一行才是需要看的。
                  //
                  // 判定按**显示精度**比：`to = 4.496` 会印成 `4.50`，拿原始值比会得到
                  // 「4.50 → 目标 4.5」这种自相矛盾的一行。
                  const shownTo = correction.to.toFixed(2);
                  const shownTarget = correction.target.toFixed(2);
                  const missed = Number(shownTo) < Number(shownTarget);
                  return (
                    <li
                      key={correction.token}
                      data-correction={correction.token}
                      data-missed={missed || undefined}
                    >
                      <code className="nexus-theme-correction-name">{correction.token}</code>
                      <span className="nexus-theme-correction-ratio">
                        {t('theme.corrections.entry', {
                          from: correction.from.toFixed(2),
                          to: shownTo
                        })}
                        {missed && (
                          <span className="nexus-theme-correction-missed">
                            {/* 目标是个算出来的比值（`√(4.5 × 主文字比值)`），不取整会印出
                                6.562770729654717 这种。 */}
                            {t('theme.corrections.missed', {
                              target: correction.target.toFixed(1)
                            })}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>

      <Dialog
        open={overridesOpen}
        onClose={() => setOverridesOpen(false)}
        label={t('theme.overrides.title')}
        panelClassName="nexus-theme-overrides-dialog"
        initialFocusSelector="[data-dialog-close]"
      >
        <h3 className="nexus-theme-group-title">{t('theme.overrides.title')}</h3>
        <ul className="nexus-theme-overrides-list">
          {Object.entries(overrides).map(([token, value]) => (
            <li key={token} data-override-row={token}>
              <span className="nexus-theme-override-swatch" style={{ backgroundColor: value }} />
              <code className="nexus-theme-token-name">{token}</code>
              <span className="nexus-theme-override-value">{value}</span>
              <button
                type="button"
                className="nexus-theme-link"
                data-override-clear={token}
                onClick={() => applyOverrides({ [token]: null })}
              >
                {t('theme.resetToken')}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="nexus-settings-option"
          data-dialog-close=""
          onClick={() => setOverridesOpen(false)}
        >
          {t('theme.close')}
        </button>
      </Dialog>
    </div>
  );
};
