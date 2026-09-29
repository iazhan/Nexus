import React, { useMemo, useState } from 'react';
import {
  defaultTuning,
  measureTheme,
  seedsToTokensWithReport,
  type Base16Slot,
  type ContrastFailure,
  type Tuning
} from '@nexus/theme';
import { applyOverrides, applySchemePatch, themeManager } from '../platform.js';
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
import { ThemeTransfer } from './ThemeTransfer.js';

/**
 * 两档主题编辑器。**基础档改 16 个种子 + 5 个系数**（改完派生整条重跑），**高级档改 43 个 token**
 * （盖在派生结果之上）。两者的写入口都在 `platform.ts` —— 内置主题上会先 fork 成用户主题。
 *
 * 三条界面上必须成立的事：
 *
 * - **高级档动过的项切回基础档不能静默消失**：基础档顶部常驻一条「有 N 项自定义覆盖」+ 查看入口。
 * - **修正要说出来**：基础档列出哪些 token 被自动修正过、从多少修到多少；高级档对不达标的覆盖项
 *   标出实际比值与目标比值。只修正不说，用户不知道自己改的种子被动了；只说不修正，用户会存下
 *   一个不可读的主题。
 * - **预览必须是真组件**（见 `ThemePreview.tsx`）。
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

export const ThemeEditor: React.FC = () => {
  const { t } = useLocale();
  // `resolvedTheme` 的引用每次重解析都换，用它当依赖就够 —— 改种子与改覆盖项都会走到这里。
  const { resolvedTheme } = useTheme();
  const [tier, setTier] = useState<Tier>('basic');
  const [overridesOpen, setOverridesOpen] = useState(false);

  const scheme = themeManager.activeScheme;
  const overrides = themeManager.overrides;
  const overrideCount = Object.keys(overrides).length;
  const editable = themeManager.isEditable;

  // 修正记录来自**不带覆盖项**的派生：覆盖项是用户手写的值，不在「自动修正」的范围内。
  const report = useMemo(
    () => (scheme ? seedsToTokensWithReport(scheme) : null),
    [scheme, resolvedTheme]
  );

  // 不达标的配对按 token 归并 —— 一个 token 可能同时落在好几个承载面上。
  const failuresByToken = useMemo(() => {
    const map = new Map<string, ContrastFailure[]>();
    for (const failure of measureTheme(resolvedTheme.tokens).failures) {
      const list = map.get(failure.token);
      if (list) list.push(failure);
      else map.set(failure.token, [failure]);
    }
    return map;
  }, [resolvedTheme]);

  const palette = scheme?.palette;
  const tuning: Required<Tuning> | null = scheme
    ? { ...defaultTuning(scheme.variant), ...scheme.tuning }
    : null;

  return (
    <div className="nexus-theme-editor" data-theme-editor="">
      <div className="nexus-theme-editor-main">
        <div className="nexus-theme-editor-head">
          <span className="nexus-settings-field-label">{t('theme.editor.title')}</span>
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
        </div>

        <p className="nexus-settings-field-description">
          {editable ? t('theme.editor.description') : t('theme.editor.forkHint')}
        </p>

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
              onClick={() => applyOverrides(Object.fromEntries(Object.keys(overrides).map((k) => [k, null])))}
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

            {report && report.corrections.length > 0 && (
              <section
                className="nexus-theme-corrections"
                data-corrections={report.corrections.length}
              >
                <h3 className="nexus-theme-group-title">
                  {t('theme.corrections.title', { count: String(report.corrections.length) })}
                </h3>
                <p className="nexus-settings-field-description">
                  {t('theme.corrections.description')}
                </p>
                <ul className="nexus-theme-corrections-list">
                  {report.corrections.map((correction) => (
                    <li key={correction.token} data-correction={correction.token}>
                      <code className="nexus-theme-token-name">{correction.token}</code>
                      <span className="nexus-theme-corrections-ratio">
                        {t('theme.corrections.entry', {
                          from: correction.from.toFixed(2),
                          to: correction.to.toFixed(2),
                          target: String(correction.target)
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <div className="nexus-theme-advanced" data-theme-tier-panel="advanced">
            {TOKEN_GROUPS.map((group) => (
              <section className="nexus-theme-tokens" key={group.id} data-theme-token-group={group.id}>
                <h3 className="nexus-theme-group-title">{t(group.labelKey)}</h3>
                {group.tokens.map((token) => {
                  const value = resolvedTheme.tokens[token] ?? COLOUR_FALLBACK;
                  const overridden = token in overrides;
                  const failures = failuresByToken.get(token) ?? [];
                  const worst = failures[0];
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
          </div>
        )}

        <ThemeTransfer />
      </div>

      <ThemePreview />

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
