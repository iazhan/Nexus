import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../../hooks.js';
import type { ViewerRendererProps } from '../types.js';
import { relativePathFrom, toAssetUrl } from '@nexus/core';
import { formatFileSize } from '../../workspace/file-size.js';
import {
  clampZoom,
  fitZoom,
  stepZoom,
  wheelZoomFactor,
  zoomPercent,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN
} from '../zoom.js';

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 滚轮缩放要「光标下那一点不动」，为此记下缩放前光标与图片的相对关系。
 *
 * `fraction` 是光标在图片内的相对位置（0–1），`cursor` 是它在 stage **内容区坐标**
 * 里的位置（已扣掉内边距）—— 后者与 `scrollLeft` 同原点，所以能直接相减。
 */
interface ZoomAnchor {
  readonly fractionX: number;
  readonly fractionY: number;
  readonly cursorX: number;
  readonly cursorY: number;
}

/**
 * stage 的**可用内容区**尺寸（扣掉内边距）。
 *
 * 「适合窗口」要按能放东西的地方算，不是按容器外框 —— 不扣内边距的话算出来的图会
 * 比可用区域大 32px，于是「适合窗口」之后立刻出现滚动条，而那正是它要消除的东西。
 */
function measureStage(stage: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(stage);
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return {
    width: Math.max(0, stage.clientWidth - paddingX),
    height: Math.max(0, stage.clientHeight - paddingY)
  };
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
 * `offsetWidth` 会被缩放影响 —— 用它断言，一张 4000px 宽的照片在任何窗口里都「尺寸不对」。
 * 所以信息面板读的是 `naturalWidth`，而**缩放只改渲染尺寸、绝不碰它**。
 *
 * ## 默认缩放为什么是「适合窗口」而不是 100%
 *
 * 与 PDF 正好相反。PDF 的 100% 有物理含义（`BASE_SCALE` 是 1/72 英寸 → CSS 像素，
 * 即「纸面实际大小」）；图片的 100% 只是「4000px 就是 4000px」—— 打开一张 4000px 的照片
 * 若按 100% 显示，用户第一眼只能看见它的四分之一。图片查看器的第一诉求是「先看见整张」，
 * 所以打开即 fit，而 100%（`实际大小`）是一个**显式动作**。
 *
 * 自动 fit 只在 `onLoad` 那一次发生：之后窗口再怎么变都不重算 —— 用户手动调过缩放之后
 * 不该被 resize 覆盖，而「每次都自动回到 fit」会让手动调的那一下白按。
 *
 * ## 缩放为什么改 `width/height` 而不是 `transform: scale`
 *
 * `transform` 不改布局盒，滚动条与 `scrollWidth` 都不会跟着变，于是放大之后**滚不到**
 * 溢出部分 —— 画面看起来正常，只是右边和下边永远够不着。显式给 `width/height` 则
 * 滚动几何是真的，`getBoundingClientRect` 也是真的。
 *
 * 代价是布局每帧都要重算，所以**滚轮连滚时靠 `zoomRef` 同步写回**：一帧内滚两格时
 * 第二格必须基于第一格的结果，否则连滚两格只放大一格。
 *
 * ## 文件大小为什么发 HEAD 而不是走 IPC
 *
 * 渲染器手里没有索引（轻量模式下更没有任何索引），而 `nexus-asset://` 的 handler
 * 对 `HEAD` **保留 headers 但不返回 body**（`asset-protocol.ts` 的 `isHead` 分支），
 * `content-length` 就在里面。为此新开一条 IPC 通道要走 core 通道表 + 主进程 + preload
 * 三处，而 CSP 的 `connect-src` 早就放行了 `nexus-asset:`（pdfjs 的 Range 请求就走它）。
 *
 * 取不到就**不显示**：文件大小是锦上添花的信息，它失败不该把查看器拖进错误态。
 *
 * ## 相对路径为什么要跟文件名比一下
 *
 * `citationBase` 在工作区模式下是工作区根、轻量模式下是文档所在目录。后者算出来的
 * 「相对路径」就是文件名本身 —— 与左边那个名字逐字相同，多显示一遍只是噪声。
 * 判据就这一条：**算出来与文件名相同就不显示**。
 *
 * ## 状态为什么不用手动重置
 *
 * 组件身份由外壳的 `key={doc.path}` 决定（与 `ErrorBoundary` 的 `resetKey`
 * 同一个理由）：换一张图就是换一个组件实例，上一张的失败状态、尺寸与缩放不会
 * 挂到下一张上。没有 key 的话，从坏图切到好图会一直停在错误卡上。
 */
const ImageRenderer: React.FC<ViewerRendererProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const [size, setSize] = useState<ImageSize | null>(null);
  const [failed, setFailed] = useState(false);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [zoomDraft, setZoomDraft] = useState(() => zoomPercent(ZOOM_DEFAULT));
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const zoomInputRef = useRef<HTMLInputElement | null>(null);
  /** 当前值，**同步**写回 —— 一帧里连滚两格时第二格要基于第一格的结果。 */
  const zoomRef = useRef(zoom);
  /** 上一次 effect 跑时的值，用来判断「缩放真的变了」。 */
  const renderedZoomRef = useRef(zoom);
  const pendingAnchorRef = useRef<ZoomAnchor | null>(null);

  const attachStage = useCallback((node: HTMLDivElement | null): void => {
    stageRef.current = node;
    setStageElement(node);
  }, []);

  // 文件大小只能问资源通道要。取不到就静默降级。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(toAssetUrl(doc.path), { method: 'HEAD' });
        const header = response.headers.get('content-length');
        if (header === null) return;
        const bytes = Number(header);
        if (!cancelled && Number.isFinite(bytes) && bytes > 0) setFileSize(bytes);
      } catch {
        // 通道不可用（协议没注册、测试环境）时静默降级 —— 不显示大小而已。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.path]);

  /**
   * 缩放的唯一入口。**同步**写 `zoomRef` 再 `setZoom` —— 见文件头关于连滚两格那段。
   */
  const applyZoom = (next: number, anchor: ZoomAnchor | null = null): void => {
    const clamped = clampZoom(next);
    if (clamped === zoomRef.current) return;
    zoomRef.current = clamped;
    pendingAnchorRef.current = anchor;
    setZoom(clamped);
  };

  /** 适合窗口：按实测的可用区域算，不是按图片自身。 */
  const applyFit = (): void => {
    const stage = stageRef.current;
    if (stage === null || size === null) return;
    const available = measureStage(stage);
    applyZoom(fitZoom(size.width, size.height, available.width, available.height));
  };

  // 缩放变化之后：有锚点就按锚点重算滚动位置，没有就把滚动位置夹回合法范围。
  // 必须等下一帧 —— 新的 `width/height` 还没进 DOM 时量到的几何是旧的。
  useEffect(() => {
    if (renderedZoomRef.current === zoom) return;
    renderedZoomRef.current = zoom;

    const stage = stageRef.current;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;

    const frame = requestAnimationFrame(() => {
      if (stage === null) return;
      const image = imageRef.current;
      if (anchor !== null && image !== null) {
        stage.scrollLeft = Math.max(0, anchor.fractionX * image.offsetWidth - anchor.cursorX);
        stage.scrollTop = Math.max(0, anchor.fractionY * image.offsetHeight - anchor.cursorY);
        return;
      }
      // 按钮缩放 / 缩到不溢出：把滚动位置夹回合法范围，别留一个滚不动的偏移。
      stage.scrollLeft = Math.min(
        stage.scrollLeft,
        Math.max(0, stage.scrollWidth - stage.clientWidth)
      );
      stage.scrollTop = Math.min(
        stage.scrollTop,
        Math.max(0, stage.scrollHeight - stage.clientHeight)
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [zoom]);

  // 草稿与源值单向同步。正在输入时不覆盖 —— 用户敲到一半被改写是最恼人的那种 bug。
  useEffect(() => {
    if (document.activeElement === zoomInputRef.current) return;
    setZoomDraft(zoomPercent(zoom));
  }, [zoom]);

  /**
   * Ctrl / Cmd + 滚轮缩放，以光标为锚点。
   *
   * **必须带修饰键**：stage 本身是可滚动容器，纯滚轮留给滚动 —— 抢掉它等于把「翻看
   * 一张长图」变成「什么都做不了」。触控板捏合在 Chromium 里就是 `wheel` + `ctrlKey`，
   * 所以这一条同时覆盖了捏合。
   *
   * 到上限 / 下限之后仍然 `preventDefault`：不拦的话那几次滚轮会穿透到 Electron 的
   * 界面缩放，用户看到的是「整窗忽大忽小」。
   */
  useEffect(() => {
    if (stageElement === null) return;

    const anchorFrom = (event: WheelEvent): ZoomAnchor | null => {
      const image = imageRef.current;
      if (image === null) return null;
      const rect = image.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      const stageRect = stageElement.getBoundingClientRect();
      const style = getComputedStyle(stageElement);
      return {
        fractionX: (event.clientX - rect.left) / rect.width,
        fractionY: (event.clientY - rect.top) / rect.height,
        cursorX: event.clientX - stageRect.left - (parseFloat(style.paddingLeft) || 0),
        cursorY: event.clientY - stageRect.top - (parseFloat(style.paddingTop) || 0)
      };
    };

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const previous = zoomRef.current;
      const next = clampZoom(previous * wheelZoomFactor(event.deltaY));
      if (next === previous) return;
      zoomRef.current = next;
      pendingAnchorRef.current = anchorFrom(event);
      setZoom(next);
    };

    stageElement.addEventListener('wheel', onWheel, { passive: false });
    return () => stageElement.removeEventListener('wheel', onWheel);
  }, [stageElement]);

  const commitZoomDraft = (): void => {
    const parsed = Number.parseInt(zoomDraft, 10);
    const next = Number.isFinite(parsed) ? clampZoom(parsed / 100) : zoomRef.current;
    applyZoom(next);
    // 手动写回草稿：值可能被夹过（输入 999 → 300），而同步 effect 只在 `zoom` **变化**
    // 时跑 —— 输入一个夹完仍等于当前值的数时它不跑，草稿会一直停在用户敲的串上。
    setZoomDraft(zoomPercent(next));
  };

  const zoomDraftKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitZoomDraft();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setZoomDraft(zoomPercent(zoomRef.current));
    }
  };

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

  const relativePath = relativePathFrom(doc.citationBase, doc.path);
  const pathLabel =
    relativePath === null || relativePath === doc.name ? null : relativePath.replace(/\\/g, '/');

  return (
    <div className="nexus-image-viewer" data-zoom={zoomPercent(zoom)}>
      <div className="nexus-image-toolbar">
        <button
          type="button"
          className="nexus-image-fit-button"
          data-zoom-action="fit"
          onClick={applyFit}
          disabled={size === null}
        >
          {t('viewer.image.fitWindow')}
        </button>
        <button
          type="button"
          className="nexus-image-fit-button"
          data-zoom-action="actual"
          onClick={() => applyZoom(ZOOM_DEFAULT)}
          disabled={size === null}
        >
          {t('viewer.image.actualSize')}
        </button>

        <span className="nexus-image-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="nexus-image-zoom-button"
          aria-label={t('viewer.image.zoomOut')}
          title={t('viewer.image.zoomOut')}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => applyZoom(stepZoom(zoomRef.current, -1))}
        >
          −
        </button>
        {/* 缩放比例可直接改。`%` 画在框外 —— 塞进 `value` 的话每次改数字都要先删掉它。 */}
        <input
          ref={zoomInputRef}
          type="text"
          inputMode="numeric"
          className="nexus-image-zoom-level"
          aria-label={t('viewer.image.zoomLevelLabel')}
          value={zoomDraft}
          onChange={(event) => setZoomDraft(event.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitZoomDraft}
          onKeyDown={zoomDraftKeyDown}
        />
        <span className="nexus-image-zoom-suffix">%</span>
        <button
          type="button"
          className="nexus-image-zoom-button"
          aria-label={t('viewer.image.zoomIn')}
          title={t('viewer.image.zoomIn')}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => applyZoom(stepZoom(zoomRef.current, 1))}
        >
          +
        </button>
      </div>

      <div className="nexus-image-stage" ref={attachStage}>
        <img
          ref={imageRef}
          className="nexus-image-content"
          src={toAssetUrl(doc.path)}
          alt={doc.name}
          draggable={false}
          style={
            size === null
              ? undefined
              : { width: size.width * zoom, height: size.height * zoom }
          }
          onLoad={(event) => {
            const width = event.currentTarget.naturalWidth;
            const height = event.currentTarget.naturalHeight;
            setSize({ width, height });
            // 打开即「适合窗口」—— 理由见文件头。stage 此时一定已经布局过（img 就在它里面）。
            const stage = stageRef.current;
            if (stage === null || !(width > 0) || !(height > 0)) return;
            const available = measureStage(stage);
            applyZoom(fitZoom(width, height, available.width, available.height));
          }}
          onError={() => setFailed(true)}
        />
      </div>

      <div className="nexus-image-caption">
        <span className="nexus-image-name">{doc.name}</span>
        <span className="nexus-image-meta">
          {pathLabel !== null && (
            <span className="nexus-image-path" title={doc.path}>
              {pathLabel}
            </span>
          )}
          {size && (
            <span className="nexus-image-size">
              {size.width} × {size.height}
            </span>
          )}
          {fileSize !== null && (
            <span className="nexus-image-bytes">{formatFileSize(fileSize)}</span>
          )}
        </span>
      </div>
    </div>
  );
};

export default ImageRenderer;
