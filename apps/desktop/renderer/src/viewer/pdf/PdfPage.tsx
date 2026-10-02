import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { pdfjsLib } from './pdf-runtime.js';

/** scale=1 时的页面尺寸（PDF 单位）。连续模式用它给还没渲染的页撑出占位高度。 */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface PdfPageProps {
  readonly pdfDocument: PDFDocumentProxy;
  /** 1 起。 */
  readonly pageNumber: number;
  /** 最终 scale ＝ `BASE_SCALE × 缩放倍率`。 */
  readonly scale: number;
  /** 这一页的估算尺寸（取第一页），未渲染时用它撑高度。 */
  readonly estimatedSize: PageSize;
  /**
   * 懒渲染的滚动容器。`null` ＝ 还没有容器，先不观察；连续模式在 stage 挂载后传进来。
   *
   * **必须是真正的滚动元素**：`IntersectionObserver` 的 `rootMargin` 只对 root 生效，
   * 用 viewport 当 root 时元素被 stage 裁掉的那部分不算 intersecting，
   * 「提前 400px 渲染」就完全失效 —— 快速滚动会看到一片空白。
   */
  readonly scrollRoot: HTMLElement | null;
  /** `true` ＝ 不观察、立刻渲染。单页模式用（那一页本来就在视野里）。 */
  readonly eager?: boolean;
}

/**
 * 一页 PDF：canvas（像素）＋ 文本层（可选择的透明文字）。
 *
 * ## 懒渲染
 *
 * 连续模式会给每一页都挂一个组件，但**只有进入视野的那几页真的解析和绘制**。
 * 判据是 `IntersectionObserver`，不是「离当前页多远」—— 后者要父组件知道每一页的高度，
 * 而高度在渲染出来之前只能估。
 *
 * 一旦渲染过就**不再卸载**（`active` 只从 false 变 true）：卸载会让滚回去的页面重新
 * 解析一次，而 pdfjs 的 `getPage` 不便宜。内存换的是滚动流畅度，页数在几百以内划算。
 *
 * ## 取消不是失败
 *
 * 缩放与翻页都会取消上一个 `renderTask`，它以 `RenderingCancelledException` **拒绝
 * promise** —— 那是正常路径。不区分它的话，快速缩放会持续弹出「加载失败」。
 */
const PdfPage: React.FC<PdfPageProps> = ({
  pdfDocument,
  pageNumber,
  scale,
  estimatedSize,
  scrollRoot,
  eager = false
}) => {
  const [active, setActive] = useState(eager);
  const [rendered, setRendered] = useState<PageSize | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) return;
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setActive(true);
      },
      { root: scrollRoot, rootMargin: '400px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, scrollRoot]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    const draw = async (): Promise<void> => {
      const page = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const viewport = page.getViewport({ scale });
      // 这一页的**原尺寸**（scale=1），与父组件传进来的 `estimatedSize` 同一个量纲。
      // `getViewport` 是纯算术，多调一次不值得省。
      const intrinsic = page.getViewport({ scale: 1 });
      // 按设备像素渲染。不做的话在 Windows 150% 系统缩放下 canvas 会被拉伸模糊 ——
      // 那是本机的默认状态，不是边缘情形。
      const outputScale = new pdfjsLib.OutputScale();
      canvas.width = Math.floor(viewport.width * outputScale.sx);
      canvas.height = Math.floor(viewport.height * outputScale.sy);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext('2d');
      if (!context) return;

      // 文本与画面并行取：串行会让「翻页后要等一下文字才能选」成为常态。
      const textContentPromise = page.getTextContent();
      renderTask = page.render({
        canvasContext: context,
        viewport,
        // 手拼 3×3 仿射矩阵，不用 `outputScale.transform`：pdfjs 4.10.38 的
        // `OutputScale` 声明里**没有**这个 getter（运行时存在，类型缺失），
        // 用它就得写 `as` 断言 —— 而断言会掩盖「pdfjs 换版本后 getter 改名」。
        // 矩阵形状是 pdfjs 的公开契约（`[sx, 0, 0, sy, 0, 0]`），直接写出来更稳。
        transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : undefined
      });
      const [textContent] = await Promise.all([textContentPromise, renderTask.promise]);
      if (cancelled) return;

      const container = textLayerRef.current;
      if (!container) return;
      container.replaceChildren();
      // canvas 画不出「可选择的字」，选区只能来自这一层。`--scale-factor` 是
      // pdfjs 的尺寸基准（字号与坐标都写成 `calc(Npx * var(--scale-factor))`），
      // 必须等于 viewport 的 scale —— 少了它文字会全部叠在左上角。
      container.style.setProperty('--scale-factor', String(viewport.scale));
      textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container,
        viewport
      });
      await textLayer.render();
      if (cancelled) return;

      // 真实尺寸回写一次：估算取自第一页，而 PDF 里混着不同纸张尺寸是常见的。
      // **存原尺寸（scale=1），不是当前 scale 下的绝对像素。** 存绝对像素的话缩放后
      // 容器会一直停在旧高度 —— 新高度要等这次渲染结束才回写，而 canvas 的 style 尺寸
      // 在 `getPage` 一 resolve 就变了，中间那段窗口里 canvas 比容器大、文本层对不齐；
      // 更麻烦的是父组件「缩放后对齐」量到的也是旧高度。存原尺寸，容器就跟着 `scale` 立刻变。
      setRendered({ width: intrinsic.width, height: intrinsic.height });
    };

    draw().catch((error: unknown) => {
      if (error instanceof pdfjsLib.RenderingCancelledException) return;
      // 单页失败不该让整个阅读器变错误卡 —— 连续模式下旁边几十页都是好的。
      // 真实失败（文件被换掉）会由加载阶段的 `failed` 接住。
      if (!cancelled) console.warn(`[PdfPage] page ${pageNumber} failed to render:`, error);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [active, pdfDocument, pageNumber, scale]);

  const width = (rendered?.width ?? estimatedSize.width) * scale;
  const height = (rendered?.height ?? estimatedSize.height) * scale;

  return (
    <div
      ref={containerRef}
      className="nexus-pdf-page"
      data-page-number={pageNumber}
      data-rendered={active ? 'true' : 'false'}
      style={{ width: `${Math.floor(width)}px`, height: `${Math.floor(height)}px` }}
    >
      <canvas ref={canvasRef} className="nexus-pdf-canvas" />
      {/* 文本层：透明文字浮在 canvas 上，只为让浏览器能选中它。
          两者必须同一个 viewport，否则选中的位置与看到的字对不上。 */}
      <div ref={textLayerRef} className="nexus-pdf-text-layer" />
    </div>
  );
};

export default PdfPage;
