/**
 * 「关于」分组。
 *
 * ## 为什么是专用组件而不是一堆 `FieldDef`
 *
 * 通用布局回答的是「这一项你能改成什么」—— 标签、说明、控件、重置键。而这一页回答的是
 * 「它是什么」：一张身份卡（名字 + 版本号 + 一句说明 + **实时**的更新状态 + 唯一的动作）、
 * 一排项目链接。没有一项有取值域，硬塞进 `FieldDef` 只会得到几个空壳 ——
 * 而版本号旁边挂一句「这一刻正在运行的版本」的描述，读起来就是一个普通的设置行，
 * 那正是它从 `general` 搬出来的原因。
 *
 * ## 但「怎么读版本、怎么开窗」仍然只有一份定义
 *
 * 版本号与按钮都走注册表里的 `APP_VERSION_FIELD`（`readonlyValue` / `run` / `actionLabelKey`），
 * 这里只负责画。手写一遍的话，「主进程的 `app.getVersion()` 是唯一来源」这条判据就有了两处
 * 落点，而两处迟早不一致。
 *
 * 更新状态那一行走 `useUpdateNotice` 而不是 `useUpdateState`：后者跟着下载进度重渲染，
 * 而这一行只关心阶段与版本号 —— 判据与主窗口那条提示条完全相同（见 `use-update-state.ts`）。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../hooks.js';
import { updateStatusText, updateStatusTone } from '../update/status-text.js';
import { ISSUES_URL, RELEASES_URL, REPOSITORY_URL } from '../update/links.js';
import { useUpdateNotice } from '../update/use-update-state.js';
import { APP_VERSION_FIELD } from './registry.js';

export const AboutSection: React.FC = () => {
  const { t } = useLocale();
  const state = useUpdateNotice();
  const [version, setVersion] = useState<string | null>(null);

  /** 取不到就不画那一行（与 `FieldRow` 的只读值同一条纪律），而不是画一个空框。 */
  useEffect(() => {
    let alive = true;
    const read = APP_VERSION_FIELD.readonlyValue;
    if (!read) return;
    void read().then(
      (next) => {
        if (alive) setVersion(next);
      },
      () => {
        if (alive) setVersion(null);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  /** 链接与开门都走主进程 —— 渲染进程里点 `<a href>` 会把整个设置窗口导航走，而它没有地址栏。 */
  const openExternal = useCallback((url: string) => {
    void window.nexus?.openExternal?.(url);
  }, []);

  const openUpdateWindow = useCallback(() => {
    void APP_VERSION_FIELD.run?.();
  }, []);

  return (
    <section className="nexus-settings-section" data-section="about">
      <h2 className="nexus-settings-section-title">{t('settings.section.about')}</h2>

      {/* `data-field` 是**搜索跳转的落点** —— 这一行是手写的，不挂它的话
          「敲『检查更新』得到『当前版本』」之后没地方可滚。 */}
      <div className="nexus-about-hero" data-field={APP_VERSION_FIELD.id}>
        <span className="nexus-about-name">Nexus</span>

        {version ? (
          <p className="nexus-about-version">
            <span className="nexus-about-version-label">{t(APP_VERSION_FIELD.labelKey)}</span>
            <span className="nexus-about-version-value" data-field-readonly={APP_VERSION_FIELD.id}>
              {version}
            </span>
          </p>
        ) : null}

        <span className="nexus-about-tagline">{t('settings.about.tagline')}</span>

        {/* 状态点与主窗口提示条、更新窗口同一套色调判据（`updateStatusTone`）。 */}
        <p className="nexus-about-status" data-about-status="" data-tone={updateStatusTone(state)}>
          {updateStatusText(state, t)}
        </p>

        <div className="nexus-about-action">
          <button
            type="button"
            className="nexus-settings-action-button"
            data-field-action={APP_VERSION_FIELD.id}
            onClick={openUpdateWindow}
          >
            {t(APP_VERSION_FIELD.actionLabelKey ?? APP_VERSION_FIELD.labelKey)}
          </button>
        </div>
      </div>

      <div className="nexus-about-links" role="group" aria-label={t('settings.about.linksAria')}>
        <button
          type="button"
          className="nexus-about-link"
          data-about-link="repository"
          onClick={() => openExternal(REPOSITORY_URL)}
        >
          {t('settings.about.repository')}
        </button>
        <button
          type="button"
          className="nexus-about-link"
          data-about-link="releases"
          onClick={() => openExternal(RELEASES_URL)}
        >
          {t('settings.about.releases')}
        </button>
        <button
          type="button"
          className="nexus-about-link"
          data-about-link="issues"
          onClick={() => openExternal(ISSUES_URL)}
        >
          {t('settings.about.issues')}
        </button>
      </div>
    </section>
  );
};
