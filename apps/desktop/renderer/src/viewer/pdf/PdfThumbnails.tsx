import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useLocale } from '../../hooks.js';
import { pdfjsLib } from './pdf-runtime.js';

/** 缩略图的 CSS 像素宽。120–160 之间：再窄看不清版式，再宽侧栏就吃掉正文了。 */
const THUMB_WIDTH = 132;

export interface PdfThumbnailsProps {
  readonly pdfDocument: PDFDocumentProxy;
  readonly totalPages: number;
  readonly activePage: number;
  /** 侧栏自己的滚动容器 —— 缩略图的懒渲染以它为 root。 */
  readonly scrollRoot: HTMLElement | null;
  readonly onSelect: (page: number) => void;
}

/**
 * 缩略图列表。
 *
 * **懒渲染的理由与正文页不同**：正文页是不画就没有内容，缩略图是**画了也没人看** ——
 * 一屏只看得到十来个，而 300 页的 PDF 会把 300 张位图一次性塞进内存。
 * 所以同样用 `IntersectionObserver`，但渲染过就不卸载（滚回去重新解析更贵）。
 */
const PdfThumbnails: React.FC<PdfThumbnailsProps> = ({
  pdfDocument,
  totalPages,
  activePage,
  scrollRoot,
  onSelect
}) => {
  const { t } = useLocale();

  return (
    <ul className="nexus-pdf-thumbs">
      {Array.from({ length: totalPages }, (_, index) => {
        const pageNumber = index + 1;
        return (
          <PdfThumbnail
            key={pageNumber}
            pdfDocument={pdfDocument}
            pageNumber={pageNumber}
            active={pageNumber === activePage}
            scrollRoot={scrollRoot}
            label={t('viewer.pdf.jumpToPage', { page: String(pageNumber) })}
            onSelect={onSelect}
          />
        );
      })}
    </ul>
  );
};

interface PdfThumbnailProps {
  readonly pdfDocument: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly active: boolean;
  readonly scrollRoot: HTMLElement | null;
  readonly label: string;
  readonly onSelect: (page: number) => void;
}

const PdfThumbnail: React.FC<PdfThumbnailProps> = ({
  pdfDocument,
  pageNumber,
  active,
  scrollRoot,
  label,
  onSelect
}) => {
  const [visible, setVisible] = useState(false);
  const itemRef = useRef<HTMLLIElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (visible) return;
    const element = itemRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { root: scrollRoot, rootMargin: '300px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, scrollRoot]);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    const draw = async (): Promise<void> => {
      const page = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      // 按页宽算出「正好 132px 宽」的 scale，而不是用固定 scale ——
      // 不同纸张尺寸的页混在一份 PDF 里很常见，固定 scale 会让它们高矮不齐。
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
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
        transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : undefined
      });
      await renderTask.promise;
    };

    draw().catch((error: unknown) => {
      if (error instanceof pdfjsLib.RenderingCancelledException) return;
      // 单张缩略图画不出来不该影响整条列表 —— 正文页仍然是好的。
      if (!cancelled) console.warn(`[PdfThumbnails] page ${pageNumber} failed:`, error);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [visible, pdfDocument, pageNumber]);

  return (
    <li ref={itemRef} className="nexus-pdf-thumb">
      <button
        type="button"
        className="nexus-pdf-thumb-button"
        data-active={active || undefined}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(pageNumber)}
      >
        <canvas ref={canvasRef} className="nexus-pdf-thumb-canvas" />
        <span className="nexus-pdf-thumb-number">{pageNumber}</span>
      </button>
    </li>
  );
};

export default PdfThumbnails;
