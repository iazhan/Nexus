import React from 'react';
import { useLocale } from '../hooks.js';
import type { ViewerDocumentDescriptor } from './types.js';

export interface ViewerUnavailableProps {
  readonly document: ViewerDocumentDescriptor;
}

/**
 * 「这个渲染器登记过，但它的包没加载下来」的如实说明。
 *
 * 与 `ViewerPlaceholder` 的区别是**哪一环坏了**：那个说「当前构建里就没有这个渲染器」，
 * 这个说「本来有，这次没下载下来」。两者都不该被画成空白 —— 空白让用户无法判断
 * 是文件坏了、应用坏了，还是自己点错了。
 *
 * ## 为什么不复用 `ErrorBoundary` 的兜底卡
 *
 * 那条路会走到，但呈现的是**原始异常文本**（`Failed to fetch dynamically imported module: …`）
 * —— 那是给排查问题的人看的，不是给用户看的。而且它与「渲染器渲染到一半崩了」
 * 共用同一张卡，用户分不出「这个能力没加载上」和「这个文件有问题」，而这两件事
 * 要做的事完全不同（前者重启应用，后者换文件）。
 *
 * ## 为什么没有「重试」按钮
 *
 * 失败的 `React.lazy` 会把那次 reject **永久缓存**在该组件实例上，本进程内重试
 * 必然再抛同一个错。放一个点了没反应的按钮比不放更糟（有入口却无反馈）——
 * 所以这里只说明「重新打开应用会再加载一次」，那是本进程内唯一真实的恢复路径。
 *
 * ## 为什么用 `document.type.*` 而不是能力清单里的可读名
 *
 * 加载中的文案（`viewer.loading`）与占位页用的都是类型名，三处必须一致；
 * 从 `viewer/` 反向 import `workspace/` 的能力清单还会把依赖方向倒过来。
 */
export const ViewerUnavailable: React.FC<ViewerUnavailableProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const typeLabel = t(`document.type.${doc.type}`);

  return (
    <div
      className="nexus-workspace-empty nexus-viewer-unavailable"
      data-viewer-type={doc.type}
      role="alert"
    >
      <span className="nexus-workspace-empty-title">
        {t('viewer.unavailable', { type: typeLabel })}
      </span>
      {/* 路径照旧带上：用户要知道是哪一份文件没打开成功 */}
      <code className="nexus-workspace-empty-path">{doc.path}</code>
      <p className="nexus-workspace-empty-note">{t('viewer.unavailableHint')}</p>
    </div>
  );
};
