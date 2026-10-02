import React from 'react';
import type { AppMode } from '@nexus/core';
import { useLocale } from '../hooks.js';

export interface WorkspaceEmptyProps {
  /** 这次启动进来的模式。`null` ＝ 启动上下文还没回来。 */
  mode: AppMode | null;
  /** 已经定下来的工作区根；`null` ＝ 还没有。 */
  rootPath: string | null;
  /** 用户点了「打开文件夹」。弹框与授权都在调用方那侧（主进程）。 */
  onOpenFolder: () => void;
}

/**
 * 内容区里「没有活动文档」时的三种形态。
 *
 * | 形态 | 条件 | 画什么 |
 * | --- | --- | --- |
 * | 欢迎态 | 工作区模式、还没定目录 | 一句说明 + 「打开文件夹」按钮 |
 * | 等挑文件 | 工作区模式、有目录 | 从左侧列表挑一个文件 |
 * | 兜底 | 轻量模式 | 只会在启动的一瞬间出现 |
 *
 * ## 为什么判据里必须有 `mode`
 *
 * `rootPath === null` 同时是「轻量模式打开一个文件」与「工作区模式还没选目录」的形状，
 * 只看它会**把后者当成前者** —— 而后者正是裸启动（双击图标），退化成空编辑器
 * 就是那个要被修掉的行为。所以模式必须由调用方显式传进来，不能从 `rootPath` 反推。
 *
 * ## 欢迎态为什么要在这里画，而不是让主进程直接进一个默认工作区
 *
 * 打开一个目录等于对它做 `authorizeWorkspace` —— 那是一张**写权限**。没有目录可恢复时
 * 唯一诚实的做法是问用户，而不是猜一个（猜错的方向是把写权限发给一个用户没选的目录）。
 */
export const WorkspaceEmpty: React.FC<WorkspaceEmptyProps> = ({
  mode,
  rootPath,
  onOpenFolder
}) => {
  const { t } = useLocale();
  const needsWorkspace = mode === 'workspace' && rootPath === null;

  return (
    <div className="nexus-workspace-empty" data-workspace-empty="">
      <span className="nexus-workspace-empty-title">{t('workspace.title')}</span>
      {rootPath && <code className="nexus-workspace-empty-path">{rootPath}</code>}

      {needsWorkspace ? (
        <>
          <p className="nexus-workspace-empty-note">{t('workspace.welcomeNote')}</p>
          <button
            type="button"
            className="nexus-workspace-open-folder"
            data-workspace-open-folder=""
            onClick={onOpenFolder}
          >
            {t('workspace.openFolder')}
          </button>
        </>
      ) : (
        <p className="nexus-workspace-empty-note">
          {rootPath ? t('workspace.pickFile') : t('workspace.pending')}
        </p>
      )}
    </div>
  );
};
