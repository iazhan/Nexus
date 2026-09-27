import React, { Suspense } from 'react';
import { useLocale } from '../hooks.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import type { ViewerRendererRegistry } from './registry.js';
import { ViewerPlaceholder } from './ViewerPlaceholder.js';
import type { ViewerDocumentDescriptor } from './types.js';

export interface ViewerSurfaceProps {
  readonly document: ViewerDocumentDescriptor;
  readonly registry: ViewerRendererRegistry;
}

/**
 * Viewer 外壳 —— 所有只读文档的公共入口。
 *
 * 它只做三件事：查表、兜底、隔离。**它不认识任何一种文档格式** ——
 * 「png 用什么渲染」这个问题由 `registry` 回答，所以 P3-06/07/08 各自新增
 * 一个渲染器 + 一次 `registerLazy` 就够了，这里一行都不用改（§6 依赖要点：
 * 「shell 的接口要在 P3-05 就定稳」）。
 *
 * 三层各自的职责不能合并：
 * - `Suspense` 管**加载中**：渲染器的 chunk 还在下载时显示占位，
 *   而不是让整窗卡住或白屏。它是懒加载能成立的前提 —— 没有它，React 会
 *   把「还没加载完」当成错误抛出去。
 * - `ErrorBoundary` 管**渲染崩了**：与编辑器同一条兜底（见 `ErrorBoundary`
 *   的说明）。resetKey 绑文档路径 —— 换一份文档必须清掉上一份的错误状态，
 *   否则一份坏 PDF 会让之后每一份 PDF 都显示同一张错误卡。
 * - `ViewerPlaceholder` 管**没有渲染器**：这不是错误，是当前构建的正常状态。
 */
export const ViewerSurface: React.FC<ViewerSurfaceProps> = ({ document: doc, registry }) => {
  const { t } = useLocale();
  const renderer = registry.get(doc.type);

  if (!renderer) {
    return <ViewerPlaceholder document={doc} />;
  }

  const Renderer = renderer.component;

  return (
    <ErrorBoundary resetKey={doc.path} titleKey="error.viewerTitle">
      <div className="nexus-viewer-surface" data-viewer-type={doc.type}>
        <Suspense
          fallback={
            <div className="nexus-state-container">
              <div className="nexus-loading-spinner" />
              <p className="nexus-state-text">
                {t('viewer.loading', { type: t(`document.type.${doc.type}`) })}
              </p>
            </div>
          }
        >
          {/* `key` 与 ErrorBoundary 的 `resetKey` 同一个理由，也必须同一个值：
              换一份文档要连**渲染器自己的内部状态**一起换掉。渲染器是有状态的
              （图片的失败标记与尺寸、PDF 的当前页与缩放），没有 key 的话
              「从坏图切到好图」会一直停在上一张的错误卡上。 */}
          <Renderer key={doc.path} document={doc} />
        </Suspense>
      </div>
    </ErrorBoundary>
  );
};
