import React, { useState } from 'react';
import { userThemeMergeTarget, userThemeName } from '@nexus/theme';
import { useLocale, useSettingValue, useTheme } from '../hooks.js';
import { mergeUserThemeInto } from '../platform.js';

/**
 * 「同名互补的一对用户主题」→ 一条合并提示。
 *
 * 触发条件（三条同时成立）：
 * 1. 当前主题是**用户主题**（内置主题不在列表里，无从合并）；
 * 2. 列表里另有一套**基名相同**的 —— `Ayu Dark` 与 `Ayu Light` 同基名 `Ayu`；
 * 3. 两套的变体**不重叠** —— 两边都有浅色时合并必然丢掉一份，而丢哪一份没有好答案。
 *
 * 没有候选时**什么都不画**（不占位、不留空行）。
 *
 * 为什么是「第二次导入时提示」而不是「第一次就问你还要不要浅色」：第一次时手上只有一份方案，
 * 无从判断用户是不是真想要另一半；问了也只是把问题推给一个还没有答案的时刻。等两份都在手上
 * 再问，用户看着具体是哪两套做决定。
 *
 * 合并**不可逆**（被并掉的那套从列表消失），所以必须由用户点，且给了「不合并」。
 */
export const ThemeMergePrompt: React.FC = () => {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const themes = useSettingValue('appearance.userThemes');
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [merged, setMerged] = useState<string | null>(null);

  const active = themes.find((theme) => theme.id === resolvedTheme.id) ?? null;
  const other = active ? userThemeMergeTarget(active, themes) : null;

  if (merged) {
    return (
      <p className="nexus-theme-transfer-status" data-status="ok" data-theme-merge-status="">
        {t('theme.merge.done', { name: merged })}
      </p>
    );
  }
  if (!active || !other || dismissed.includes(other.id)) return null;

  const keep = userThemeName(active);
  const absorbed = userThemeName(other);

  return (
    <div className="nexus-theme-merge" data-theme-merge="" data-theme-merge-with={other.id}>
      <span className="nexus-theme-merge-text">
        {t('theme.merge.prompt', { keep, other: absorbed })}
      </span>
      <div className="nexus-theme-merge-actions">
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-merge-confirm=""
          onClick={() => {
            const result = mergeUserThemeInto(active.id, other.id);
            setMerged(result ? userThemeName(result) : keep);
          }}
        >
          {t('theme.merge.confirm')}
        </button>
        <button
          type="button"
          className="nexus-theme-link"
          data-theme-merge-dismiss=""
          onClick={() => setDismissed((list) => [...list, other.id])}
        >
          {t('theme.merge.dismiss')}
        </button>
      </div>
    </div>
  );
};
