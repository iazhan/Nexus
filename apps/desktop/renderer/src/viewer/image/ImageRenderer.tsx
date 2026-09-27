import React, { useState } from 'react';
import { useLocale } from '../../hooks.js';
import type { ViewerRendererProps } from '../types.js';
import { toFileUrl } from './file-url.js';

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 图片 Viewer（P3-06）—— 三个 Viewer 里最小的一个，也是唯一不依赖
 * worker / cmap / 分页的。它刻意排在 PDF 之前：用最小实现验证
 * 「AppMode.viewer → 外壳 → 标签栏 → 资源加载」整条链路。链路对了，
 * P3-07 / P3-08 就只是往里换渲染器。
 *
 * ## 为什么这里没有路径校验
 *
 * 图片走 `file://`（§10.4 定案 A），**不做 FileService 校验** —— 这是 A 方案的
 * 直接后果，不是漏了。在图片这条路上补一套「看起来像校验」的逻辑，只会让人
 * 误以为工作区边界在图片路径上成立（§10.4 第 3 条硬约束）。`checkBoundary`
 * 仍然服务于 `nexus-asset://` 与 Markdown 读写，不覆盖这里。
 *
 * ## 尺寸为什么取 naturalWidth
 *
 * 「图片尺寸正确」验收的是**图片的真实像素**，不是它在屏幕上的大小。
 * `offsetWidth` 会被 CSS 的 `max-width` 缩放影响 —— 用它断言，一张
 * 4000px 宽的照片在任何窗口里都「尺寸不对」。
 *
 * ## 状态为什么不用手动重置
 *
 * 组件身份由外壳的 `key={doc.path}` 决定（与 `ErrorBoundary` 的 `resetKey`
 * 同一个理由）：换一张图就是换一个组件实例，上一张的失败状态与尺寸不会
 * 挂到下一张上。没有 key 的话，从坏图切到好图会一直停在错误卡上。
 */
const ImageRenderer: React.FC<ViewerRendererProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const [size, setSize] = useState<ImageSize | null>(null);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{t('viewer.image.loadError')}</span>
          <p className="error-description nexus-image-error-path">{doc.path}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="nexus-image-viewer">
      <div className="nexus-image-stage">
        <img
          className="nexus-image-content"
          src={toFileUrl(doc.path)}
          alt={doc.name}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
          onError={() => setFailed(true)}
        />
      </div>
      <div className="nexus-image-caption">
        <span className="nexus-image-name">{doc.name}</span>
        {size && (
          <span className="nexus-image-size">
            {size.width} × {size.height}
          </span>
        )}
      </div>
    </div>
  );
};

export default ImageRenderer;
