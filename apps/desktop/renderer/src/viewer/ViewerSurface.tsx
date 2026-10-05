import React, { Suspense } from 'react';
import { useLocale, useSettingValue } from '../hooks.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import type { ViewerRendererRegistry } from './registry.js';
import { ViewerPlaceholder } from './ViewerPlaceholder.js';
import { ViewerDisabled } from './ViewerDisabled.js';
import { ViewerUnavailable } from './ViewerUnavailable.js';
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
 *
 * 「没有渲染器」还分两种，各有一张卡（判据都来自注册表，这里不比对设置串）：
 * 没登记 → `ViewerPlaceholder`；登记了但**被用户关掉** → `ViewerDisabled`。
 * 画成同一张卡的话，用户分不出自己该换文件还是去设置里打开。
 *
 * **「渲染器的包没下载下来」走的是 `ErrorBoundary`，但换了一张卡。** 那条路
 * 一定会经过边界（`React.lazy` 的 reject 只能由边界接），所以不另设分支 ——
 * 由 `fallback` 读注册表决定画哪张。`hasFailed` **必须在回调里读**：闭包里捕获
 * 到的是出错前那一版（`false`），第一次失败会被画成原始异常。
 */
export const ViewerSurface: React.FC<ViewerSurfaceProps> = ({ document: doc, registry }) => {
  const { t } = useLocale();

  /**
   * 订阅启停设置。**值不参与渲染** —— 它只是触发器：`registry.get()` 每次现问谓词，
   * 所以只要这个组件重渲染一次，被关掉的能力当场从画面上消失。
   *
   * 少了这一行，用户在设置里关掉 PDF 之后，已经打开的那份 PDF 会一直渲染到
   * 下一次因为别的原因重渲染 —— 表现是「改了设置没反应」，而那是最容易被当成
   * 「这个开关是坏的」的一类症状。
   */
  useSettingValue('plugins.disabled');

  const renderer = registry.get(doc.type);

  if (!renderer) {
    // 两种「没人渲染」要分开：**没登记**（当前构建里就没有）与**被关掉了**（有，但用户在
    // 设置里关了）。判据只有注册表那一个 —— 这里不比对设置串，那样就成了第二份口径。
    return registry.isCapabilityEnabled(doc.type) ? (
      <ViewerPlaceholder document={doc} />
    ) : (
      <ViewerDisabled document={doc} />
    );
  }

  const Renderer = renderer.component;

  return (
    <ErrorBoundary
      resetKey={doc.path}
      titleKey="error.viewerTitle"
      fallback={() => (renderer.hasFailed ? <ViewerUnavailable document={doc} /> : null)}
    >
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
