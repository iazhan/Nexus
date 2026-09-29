import React, { useState } from 'react';
import type { Base16Error } from '@nexus/theme';
import { useLocale } from '../hooks.js';
import { applyBase16ToCurrentTheme, base16ErrorText, type ApplyOutcome } from './theme-transfer.js';

/**
 * base16 粘贴框：粘一段 YAML / JSON，解析后**应用到当前主题**（不是另建一套主题）。
 *
 * 两处挂载共用它 —— 主题编辑器（16 个取色器上方）与设置页的导入 / 导出区。两处行为完全一样：
 * 都落到粘贴内容自己的 `variant` 那一版，缺哪一版就补哪一版（见 `applyVariantScheme`）。
 *
 * **提交是显式的，不做「边打字边解析」**：解析成功就会写盘 + 切主题，打字打到一半的文本会被
 * 当成一份配色应用上去。所以是粘完点「应用」。文本框空着时按钮禁用 —— 空串解析必然报错，
 * 按下去只会得到一条没用的红字。
 *
 * 粘贴后**不自动提交**，但会把焦点留在文本框里，用户看一眼解析结果再决定。
 *
 * 占位符里**不放示例色值**：`tokens:audit` 会把 `#rrggbb` 当颜色字面量拦下，而那是硬门禁，
 * 不该为一条文案开口子。形状示意足够说明该粘什么。
 */
type Status =
  | { kind: 'idle' }
  | { kind: 'ok'; outcome: Extract<ApplyOutcome, { ok: true }> }
  | { kind: 'error'; error: Base16Error };

export const Base16PasteBox: React.FC = () => {
  const { t } = useLocale();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const empty = text.trim() === '';

  const apply = (): void => {
    if (empty) return;
    const outcome = applyBase16ToCurrentTheme(text);
    setStatus(outcome.ok ? { kind: 'ok', outcome } : { kind: 'error', error: outcome.error });
  };

  return (
    <section className="nexus-theme-paste" data-theme-paste="">
      <span className="nexus-settings-field-label">{t('theme.paste.title')}</span>
      <p className="nexus-settings-field-description">{t('theme.paste.description')}</p>

      <textarea
        className="nexus-theme-paste-input"
        value={text}
        placeholder={t('theme.paste.placeholder')}
        aria-label={t('theme.paste.title')}
        spellCheck={false}
        data-theme-paste-input=""
        onChange={(event) => setText(event.target.value)}
      />

      <div className="nexus-theme-paste-actions">
        <button
          type="button"
          className="nexus-theme-action nexus-theme-action-primary"
          data-theme-paste-apply=""
          disabled={empty}
          onClick={apply}
        >
          {t('theme.paste.apply')}
        </button>
        {!empty && (
          <button
            type="button"
            className="nexus-theme-link"
            data-theme-paste-clear=""
            onClick={() => {
              setText('');
              setStatus({ kind: 'idle' });
            }}
          >
            {t('theme.paste.clear')}
          </button>
        )}
      </div>

      {status.kind === 'ok' && (
        <p className="nexus-theme-transfer-status" data-status="ok" data-theme-paste-status="">
          {t(status.outcome.added ? 'theme.paste.appliedAdded' : 'theme.paste.applied', {
            name: status.outcome.name,
            variant: t(`theme.mode.${status.outcome.variant}`)
          })}
          {/* 零修正不提 —— 常驻一条「0 项被调整」是噪音，用户会开始忽略这条提示。 */}
          {status.outcome.corrections > 0 &&
            ` ${t('theme.import.corrected', { count: String(status.outcome.corrections) })}`}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="nexus-theme-transfer-status" data-status="error" data-theme-paste-status="">
          {base16ErrorText(t, status.error)}
        </p>
      )}
    </section>
  );
};
