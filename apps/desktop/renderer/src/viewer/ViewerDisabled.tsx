import React from 'react';
import { useLocale } from '../hooks.js';
import type { ViewerDocumentDescriptor } from './types.js';

export interface ViewerDisabledProps {
  readonly document: ViewerDocumentDescriptor;
}

/**
 * 「你在设置里关掉了这个插件」的如实说明。
 *
 * 与另两张占位页的区别是**该做什么**，不是措辞：
 * `ViewerPlaceholder` 说「当前构建里就没有这个渲染器」（无事可做），
 * `ViewerUnavailable` 说「本来有，这次没下载下来」（重启应用），
 * 这一张说「有，但被你关了」（去设置里打开）。三张都画成空白的话，
 * 用户分不出自己该换文件、重启，还是改设置。
 *
 * 刻意**不放「去设置」按钮**：`ViewerUnavailable` 也是纯说明，两张卡同形；
 * 而且这条路径上的用户刚刚才在设置里关掉它，知道门在哪。文案里点明落点就够了。
 *
 * 判据在 `ViewerSurface`：它问 `registry.isCapabilityEnabled()` 而不是自己
 * 比对设置串 —— 「谁被关掉了」只有注册表那一个答案。
 */
export const ViewerDisabled: React.FC<ViewerDisabledProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const typeLabel = t(`document.type.${doc.type}`);

  return (
    <div
      className="nexus-workspace-empty nexus-viewer-disabled"
      data-viewer-type={doc.type}
    >
      <span className="nexus-workspace-empty-title">
        {t('viewer.disabled', { type: typeLabel })}
      </span>
      {/* 路径照旧带上：用户要知道是哪一份文件没打开 */}
      <code className="nexus-workspace-empty-path">{doc.path}</code>
      <p className="nexus-workspace-empty-note">{t('viewer.disabledHint')}</p>
    </div>
  );
};
