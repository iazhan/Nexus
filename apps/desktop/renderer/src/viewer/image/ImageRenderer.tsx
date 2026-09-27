import React, { useState } from 'react';
import { useLocale } from '../../hooks.js';
import type { ViewerRendererProps } from '../types.js';
import { toAssetUrl } from '@nexus/core';

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
 * ## 为什么走 `nexus-asset://` 而不是 `file://`
 *
 * 原方案（§10.4 定案 A）是图片走 `file://` 换取「零协议代码」。**2026-09-27 实测推翻了它**：
 * `pnpm dev` 的 renderer 来自 `http://localhost:6200`，而 **Chromium 不允许 http 页面加载
 * `file://` 子资源**（控制台报 `Not allowed to load local resource`）——
 * 于是 dev 下图片**全部**打不开，而打包产物（`file://` 页面）却正常。
 *
 * 关键在于**这不是 CSP 能解决的**：CSP 是「允许什么」的上限，管不了浏览器自身的
 * 本地资源策略。`index.html` 里原先写着「加 `img-src file:` 让 dev 与打包一致」，
 * 那句话是错的 —— 加了也拦。
 *
 * 换成 `nexus-asset://`（P3-07 建的通道）之后：dev 与打包行为一致，而且图片路径
 * **开始过 `checkBoundary` + symlink 逃逸检查** —— 定案 A 里「图片路径没有工作区边界」
 * 那个已知缺口顺带被补上，CSP 里的 `file:` 也整条去掉了。
 *
 * ## 为什么这里没有额外的路径校验
 *
 * 边界校验在**主进程**的 `nexus-asset://` handler 里（`authorizeAsset`：规范化 →
 * `checkBoundary` → 类型白名单 → symlink 逃逸）。渲染器只管把路径变成 URL ——
 * 在渲染器里再补一套「看起来像校验」的逻辑，只会让人误以为这里有第二道防线。
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
          src={toAssetUrl(doc.path)}
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
