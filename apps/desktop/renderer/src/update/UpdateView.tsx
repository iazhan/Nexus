import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compareVersions,
  type ChangelogEntry,
  type ChangelogRelease,
  type ChangelogResult
} from '../../../ipc/channels.js';
import { useLocale } from '../hooks.js';
import { useUpdateState } from './use-update-state.js';
import { updateProgressPercent, updateStatusText, updateStatusTone } from './status-text.js';
import { RELEASES_URL } from './links.js';

/**
 * 条目在某个界面语言下该显示哪一句。
 *
 * **缺哪一句就回落另一句**，而不是显示空白 —— 双语日志是渐进补全的（发版时人工写），
 * 一个版本可能只有英文。空白的条目会被读成「这一版没改什么」。
 */
function entryText(entry: ChangelogEntry, locale: string): string {
  const preferChinese = locale.toLowerCase().startsWith('zh');
  if (preferChinese) return entry.zh ?? entry.en ?? '';
  return entry.en ?? entry.zh ?? '';
}

/** 一个版本的卡片：版本号 + 日期 + 条目。 */
const ReleaseCard: React.FC<{ release: ChangelogRelease }> = ({ release }) => {
  const { t, locale, has } = useLocale();

  return (
    <article className="nexus-update-release" data-release={release.version}>
      <header className="nexus-update-release-head">
        <h3 className="nexus-update-release-version">{release.version}</h3>
        {release.date ? <span className="nexus-update-release-date">{release.date}</span> : null}
        {/* 来源要如实标出来：从 GitHub 提交信息回落的那些是英文的，而且可能只有几条。
            不标的话，用户会以为「这一版就改了这么点」。 */}
        {release.source === 'github' ? (
          <span className="nexus-update-release-source">{t('update.fromGithub')}</span>
        ) : null}
      </header>

      {release.entries.length === 0 ? (
        <p className="nexus-update-release-empty">{t('update.noEntries')}</p>
      ) : (
        <ul className="nexus-update-entries">
          {release.entries.map((entry, index) => {
            const text = entryText(entry, locale);
            const typeKey = entry.type ? `update.type.${entry.type}` : null;
            return (
              <li key={`${entry.type ?? 'x'}-${index}`} className="nexus-update-entry">
                {/* 类型徽章只在**有译文**时画。`t()` 对缺键返回键名本身，
                    直接渲染会漏出 `update.type.chore` 这种噪音。 */}
                {typeKey && has(typeKey) ? (
                  <span className="nexus-update-entry-type">{t(typeKey)}</span>
                ) : null}
                <span className="nexus-update-entry-text">{text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
};

/**
 * 更新窗口的本体：版本状态 + 更新日志 + 动作按钮。
 *
 * ## 版面形状
 *
 * 两段：**状态卡片**（固定，含状态、版本、进度与全部动作）+ **更新日志**（吃掉剩余高度、
 * 自己滚）。动作放进卡片而不是另起一行贴底，是因为「要不要更新」和「更新到哪一版」是同一个
 * 决定 —— 分成两处时，内容少的那一版会留下一条从日志区底部到窗口底部的空带，按钮孤零零
 * 挂在左下角。日志区内容少时那一行提示**垂直居中**（`.nexus-update-changelog-body`），
 * 于是剩下的空间读起来是「这一块没有内容」，而不是「渲染漏了」。
 *
 * ## 为什么没有「下载」按钮
 *
 * `autoDownload = true`：主进程发现新版本就开始下，界面上那个进度条是**它**的进度。
 * 加一个「开始下载」的按钮等于把自动下载关掉，然后为「用户关掉窗口之后谁来接着下」
 * 再造一套状态 —— 而现有设计（判据 2：发现即下，只在就绪时提示一次）已经覆盖了那条路。
 *
 * ## 跳过与稍后为什么要分开
 *
 * 见 `updater.ts` 判据 6。界面上它们并排，但语义不同：跳过是「这一版我不要」，
 * 稍后是「过 24 小时再说」。用户按「跳过」之后不会再自动看到提示条，
 * 但仍可以从这里（或设置页）打开这个窗口手动检查。
 */
export const UpdateView: React.FC = () => {
  const { t } = useLocale();
  const state = useUpdateState();
  const [changelog, setChangelog] = useState<ChangelogResult | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [installRefused, setInstallRefused] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.nexus
      ?.getChangelog?.()
      .then((result) => {
        if (alive) setChangelog(result);
      })
      .catch(() => {
        if (alive) setChangelog(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const phase = state?.phase ?? 'idle';
  const hasUpdate = phase === 'available' || phase === 'downloading' || phase === 'downloaded';

  /**
   * 「从当前版本显示到最新版本」—— 默认只留比当前版本**新**的那些。
   *
   * 用 `compareVersions` 而不是字符串比较：`0.10.0` 在字符串序里小于 `0.9.0`，
   * 而它实际更新。判据与主进程共用同一份实现（`ipc/channels.ts`）。
   */
  const releases = useMemo(() => {
    if (!changelog) return [];
    const current = state?.current;
    if (showAll || !current) return changelog;
    return changelog.filter((release) => compareVersions(release.version, current) > 0);
  }, [changelog, showAll, state?.current]);

  const guard = useCallback(async (action: () => Promise<unknown> | undefined) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, []);

  const onCheck = useCallback(() => {
    void guard(() => window.nexus?.checkForUpdates?.());
  }, [guard]);

  const onLater = useCallback(() => {
    void guard(() => window.nexus?.remindUpdateLater?.());
  }, [guard]);

  const onSkip = useCallback(() => {
    const latest = state?.latest;
    if (!latest) return;
    void guard(() => window.nexus?.skipUpdateVersion?.(latest));
  }, [guard, state?.latest]);

  const onInstall = useCallback(() => {
    setInstallRefused(false);
    void guard(async () => {
      const started = await window.nexus?.installUpdateNow?.();
      // `false` 是「有未保存的文档」—— 正常路径，不是异常。见 `updater.ts` 判据 4。
      if (started === false) setInstallRefused(true);
    });
  }, [guard]);

  const onOpenReleases = useCallback(() => {
    void window.nexus?.openExternal?.(RELEASES_URL);
  }, []);

  const percent = updateProgressPercent(state);
  const statusText = updateStatusText(state, t);

  const primaryLabel =
    phase === 'checking'
      ? t('update.checkingAction')
      : phase === 'downloading'
        ? t('update.downloadingShort')
        : t('update.checkNow');

  return (
    <div className="nexus-update-view" data-update-phase={phase}>
      <section className="nexus-update-summary" data-tone={updateStatusTone(state)}>
        <div className="nexus-update-status-row">
          {/* 装饰：状态由紧挨着的文字说清，读屏再念一遍这个点没有意义。 */}
          <span className="nexus-update-status-dot" aria-hidden="true" />
          <p className="nexus-update-status" data-update-status="">
            {statusText}
          </p>
        </div>

        <div className="nexus-update-versions">
          <span className="nexus-update-version-label">{t('update.currentVersion')}</span>
          <span className="nexus-update-version-value" data-current-version="">
            {state?.current ?? '—'}
          </span>
          {/* 有更新时把两版并排成 `0.73.0 → 0.74.0` —— 状态那行已经说过「有新版本」，
              这里要说的是「从哪儿到哪儿」。 */}
          {hasUpdate && state?.latest ? (
            <>
              <span className="nexus-update-version-arrow" aria-hidden="true">
                →
              </span>
              <span
                className="nexus-update-version-value nexus-update-version-value-latest"
                data-latest-version=""
              >
                {state.latest}
              </span>
            </>
          ) : null}
        </div>

        {phase === 'downloading' ? (
          <div
            className="nexus-update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('update.downloading', { percent: String(percent) })}
          >
            <div className="nexus-update-progress-bar" style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        {phase === 'downloaded' ? (
          <p className="nexus-update-note">{t('update.downloadedHint')}</p>
        ) : null}

        {phase === 'unsupported' ? (
          <p className="nexus-update-note">{t('update.unsupportedHint')}</p>
        ) : null}

        {phase === 'error' ? <p className="nexus-update-note">{t('update.failedHint')}</p> : null}

        {installRefused ? (
          <p className="nexus-update-note nexus-update-note-warn" role="alert">
            {t('update.installRefused')}
          </p>
        ) : null}

        {/* 顺序是**次要动作在前、主按钮最后** —— DOM 顺序即视觉顺序（整排右对齐），
            焦点顺序也就跟着读得通。靠 CSS `order` 反过来是能少改两个用例，
            但那样 Tab 会从最右边的按钮跳到最左边，而屏幕上的顺序是反的。 */}
        <div className="nexus-update-actions">
          {hasUpdate ? (
            <>
              <button type="button" className="nexus-update-button" onClick={onLater} disabled={busy}>
                {t('update.later')}
              </button>
              <button type="button" className="nexus-update-button" onClick={onSkip} disabled={busy}>
                {t('update.skip')}
              </button>
            </>
          ) : null}

          {phase === 'downloaded' ? (
            <button
              type="button"
              className="nexus-update-button nexus-update-button-primary"
              onClick={onInstall}
              disabled={busy}
            >
              {t('update.restartNow')}
            </button>
          ) : (
            <button
              type="button"
              className="nexus-update-button nexus-update-button-primary"
              onClick={onCheck}
              disabled={
                busy || phase === 'checking' || phase === 'unsupported' || phase === 'downloading'
              }
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </section>

      <section
        className="nexus-update-changelog"
        // 三种状态（加载中 / 拿不到 / 拿到了）用的是同一个类名，光看 DOM 分不出来 ——
        // 而真机用例要等的是「拉取已经落定」，不是「某个元素出现」。所以把状态显式写出来。
        data-changelog-state={
          changelog === undefined ? 'loading' : changelog === null ? 'unavailable' : 'ready'
        }
      >
        <div className="nexus-update-changelog-head">
          <h2 className="nexus-update-changelog-title">{t('update.whatsNew')}</h2>
          <label className="nexus-update-show-all">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />
            <span>{t('update.showAll')}</span>
          </label>
        </div>

        {changelog === undefined ? (
          <div className="nexus-update-changelog-body">
            <p className="nexus-update-changelog-note">{t('update.loadingChangelog')}</p>
          </div>
        ) : changelog === null ? (
          <div className="nexus-update-changelog-body">
            <p className="nexus-update-changelog-note">
              {t('update.changelogUnavailable')}{' '}
              <button type="button" className="nexus-update-link" onClick={onOpenReleases}>
                {t('update.openOnGithub')}
              </button>
            </p>
          </div>
        ) : releases.length === 0 ? (
          <div className="nexus-update-changelog-body">
            <p className="nexus-update-changelog-note">{t('update.nothingNew')}</p>
          </div>
        ) : (
          <div className="nexus-update-releases">
            {releases.map((release) => (
              <ReleaseCard key={release.version} release={release} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
