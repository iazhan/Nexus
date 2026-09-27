import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useLocale } from '../../hooks.js';
import type { ViewerRendererProps } from '../types.js';
import { toAssetUrl } from '@nexus/core';

/**
 * PDF Viewer（P3-07）。
 *
 * ## worker 必须在模块顶层指定，且用 `?url` 而不是 `new URL(..., import.meta.url)`
 *
 * `GlobalWorkerOptions.workerSrc` 是 pdfjs 的全局单例，必须在任何 `getDocument`
 * 之前设好 —— 放到 `useEffect` 里会让「第一次打开 PDF 时 worker 还没就位」成为
 * 一个只在冷启动出现的竞态。
 *
 * `?url` 让 Vite 把 worker **当作静态资源**复制出去并给出 URL，而不是把它当模块
 * 打进 JS：worker 自己会 `importScripts` / 再 import 一堆东西，被卷进主 chunk
 * 既撑大体积又可能破坏它的 ESM 形态。dev 下 URL 指向 `node_modules`，
 * 打包后指向 `assets/` 里的独立文件 —— 两种情况 pdfjs 都能 `new Worker(url)`。
 *
 * 页面在打包后是 `file://`，**`file://` 页面创建 `file://` worker 是可行的**
 * （P3-02 spike 判据 4 实测过，不是推理）。这也是为什么 worker 不需要内联成 blob。
 *
 * ## cmap 与标准字体走相对页面的绝对 URL
 *
 * 这两个目录由 `scripts/copy-pdfjs-assets.mjs` 从 `pdfjs-dist` 复制到
 * `renderer/public/pdfjs/`，于是 dev（`http://localhost:6200/pdfjs/`）与打包后
 * （`file:///.../out/renderer/pdfjs/`）都成立。
 *
 * **必须用 `document.baseURI` 拼成绝对 URL**：这两个参数会被传给 worker，
 * 而 worker 里的相对 URL 是相对 **worker 脚本**解析的，不是相对页面 ——
 * 传相对路径会得到 `assets/pdfjs/cmaps/...` 这种不存在的地址，症状是
 * **中文 PDF 静默变成空白**（cmap 取不到，字体映射缺失）。
 *
 * 缺了 cmaps 就是空白而不是报错，所以这里没有「看起来能用就行」的余地。
 */
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const CMAP_URL = new URL('./pdfjs/cmaps/', document.baseURI).href;
const STANDARD_FONT_DATA_URL = new URL('./pdfjs/standard_fonts/', document.baseURI).href;

/**
 * PDF 单位是 1/72 英寸，直接按 scale 1 渲染会明显偏小。
 *
 * **这不是「缩放功能」** —— P3-07 与 P3-06 同一口径，不做用户可调的缩放。
 * 它只是一个固定的基准换算，让页面在 100% 系统缩放下看起来是正常文档大小。
 * 用户可调的缩放归 Phase 5。
 */
const BASE_SCALE = 1.5;

/**
 * PDF Viewer —— 三个 Viewer 里唯一需要 worker、静态资源与分页的。
 *
 * ## 为什么走 `nexus-asset://` 而不是图片那条 `file://`
 *
 * 一份 50MB 的 PDF 若只能整份读进内存，打开就会卡死并吃满内存。`file://`
 * 既不支持 Range 也没有工作区边界，所以走 P3-07 新加的 `nexus-asset://`：
 * pdfjs 自带 Range 分页请求，主进程的 handler 做边界校验 + 偏移读。
 *
 * ## 状态与清理
 *
 * 组件身份由外壳的 `key={doc.path}` 决定，所以**不需要处理「换文档」** ——
 * 换一份 PDF 就是换一个组件实例。这消掉了整类「上一份文档的页数/当前页
 * 挂到下一份上」的问题。
 *
 * 两个 effect 各自负责一件事，且都必须能安全取消：
 * - 加载：`loadingTask.destroy()` 会连同已解析的文档一起释放 worker 资源。
 * - 渲染：`renderTask.cancel()` 让上一页的绘制不再往 canvas 上写。
 *   取消会以 `RenderingCancelledException` **拒绝 promise**，那是正常路径不是错误 ——
 *   不区分它的话，快速翻页会让界面弹出「加载失败」。
 */
const PdfRenderer: React.FC<ViewerRendererProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [failed, setFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── 加载文档 ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument({
      url: toAssetUrl(doc.path),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL
    });

    loadingTask.promise.then(
      (loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdfDocument(loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );

    return () => {
      cancelled = true;
      // 在途的加载也要掐断：`destroy` 对已完成的 task 是幂等的。
      void loadingTask.destroy();
    };
  }, [doc.path]);

  // ── 渲染当前页 ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDocument) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    const draw = async (): Promise<void> => {
      const page = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const viewport = page.getViewport({ scale: BASE_SCALE });
      // 按设备像素渲染。不做的话在 Windows 150% 系统缩放下 canvas 会被拉伸模糊 ——
      // 那是本机的默认状态，不是边缘情形。
      const outputScale = new pdfjsLib.OutputScale();
      canvas.width = Math.floor(viewport.width * outputScale.sx);
      canvas.height = Math.floor(viewport.height * outputScale.sy);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext('2d');
      if (!context) return;

      renderTask = page.render({
        canvasContext: context,
        viewport,
        // 手拼 3×3 仿射矩阵，不用 `outputScale.transform`：pdfjs 4.10.38 的
        // `OutputScale` 声明里**没有**这个 getter（运行时存在，类型缺失），
        // 用它就得写 `as` 断言 —— 而断言会掩盖「pdfjs 换版本后 getter 改名」。
        // 矩阵形状是 pdfjs 的公开契约（`[sx, 0, 0, sy, 0, 0]`），直接写出来更稳。
        transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : undefined
      });
      await renderTask.promise;
    };

    draw().catch((error: unknown) => {
      // 取消不是失败：快速翻页时上一个 render 一定会被取消，若把它当错误上报，
      // 正常操作会持续弹出「加载失败」。
      if (error instanceof pdfjsLib.RenderingCancelledException) return;
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber]);

  const goToPreviousPage = useCallback(() => {
    setPageNumber((current) => Math.max(1, current - 1));
  }, []);

  const goToNextPage = useCallback(() => {
    setPageNumber((current) => Math.min(pdfDocument?.numPages ?? current, current + 1));
  }, [pdfDocument]);

  if (failed) {
    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{t('viewer.pdf.loadError')}</span>
          <p className="error-description nexus-pdf-error-path">{doc.path}</p>
        </div>
      </div>
    );
  }

  const totalPages = pdfDocument?.numPages ?? 0;

  return (
    <div className="nexus-pdf-viewer">
      <div className="nexus-pdf-toolbar">
        <button
          type="button"
          className="nexus-pdf-page-button"
          onClick={goToPreviousPage}
          disabled={pageNumber <= 1}
        >
          {t('viewer.pdf.previousPage')}
        </button>
        <span className="nexus-pdf-page-indicator">
          {t('viewer.pdf.pageOf', {
            current: String(pageNumber),
            total: String(totalPages)
          })}
        </span>
        <button
          type="button"
          className="nexus-pdf-page-button"
          onClick={goToNextPage}
          disabled={totalPages === 0 || pageNumber >= totalPages}
        >
          {t('viewer.pdf.nextPage')}
        </button>
      </div>
      <div className="nexus-pdf-stage">
        {pdfDocument === null && (
          <div className="nexus-state-container">
            <div className="nexus-loading-spinner" />
            <p className="nexus-state-text">{t('viewer.pdf.loading')}</p>
          </div>
        )}
        <canvas ref={canvasRef} className="nexus-pdf-canvas" data-page-number={pageNumber} />
      </div>
      <div className="nexus-pdf-caption">
        <span className="nexus-pdf-name">{doc.name}</span>
      </div>
    </div>
  );
};

export default PdfRenderer;
