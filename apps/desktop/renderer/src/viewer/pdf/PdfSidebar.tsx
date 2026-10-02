import React, { useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useLocale } from '../../hooks.js';
import PdfOutline, { type PdfOutlineItem } from './PdfOutline.js';
import PdfThumbnails from './PdfThumbnails.js';

export type PdfSidebarTab = 'thumbnails' | 'outline';

export interface PdfSidebarProps {
  readonly tab: PdfSidebarTab;
  readonly onTabChange: (tab: PdfSidebarTab) => void;
  readonly pdfDocument: PDFDocumentProxy;
  readonly totalPages: number;
  readonly activePage: number;
  readonly outline: readonly PdfOutlineItem[];
  readonly onSelectPage: (page: number) => void;
}

/**
 * PDF 侧栏：缩略图与大纲两个标签页共用一栏。
 *
 * **两个面板放一个栏里、用标签切换，而不是左右各一栏。** 窄窗口下三栏（缩略图 | 页面 |
 * 大纲）会把正文挤到只剩一条缝，而「同时看缩略图和大纲」不是真实需求 —— 它们是
 * 「按页找」和「按标题找」两条路，一次走一条。
 *
 * 标签栏与内容区**在同一个滚动容器之外**：滚动条只属于内容区，标签跟着列表一起滚上去
 * 的话，滚到第 200 页缩略图时就没法切回大纲了。
 */
const PdfSidebar: React.FC<PdfSidebarProps> = ({
  tab,
  onTabChange,
  pdfDocument,
  totalPages,
  activePage,
  outline,
  onSelectPage
}) => {
  const { t } = useLocale();
  // 内容区自己的滚动元素，作为缩略图懒渲染的 IntersectionObserver root。
  // 用 state 而不是 ref：`null → 元素` 这一次变化必须触发子组件重新观察。
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  return (
    <aside className="nexus-pdf-sidebar" aria-label={t('viewer.pdf.sidebar')}>
      <div className="nexus-pdf-sidebar-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="nexus-pdf-sidebar-tab"
          data-tab="thumbnails"
          aria-selected={tab === 'thumbnails'}
          onClick={() => onTabChange('thumbnails')}
        >
          {t('viewer.pdf.sidebarThumbnails')}
        </button>
        <button
          type="button"
          role="tab"
          className="nexus-pdf-sidebar-tab"
          data-tab="outline"
          aria-selected={tab === 'outline'}
          onClick={() => onTabChange('outline')}
        >
          {t('viewer.pdf.sidebarOutline')}
        </button>
      </div>
      <div className="nexus-pdf-sidebar-body" ref={setScrollRoot}>
        {tab === 'thumbnails' ? (
          <PdfThumbnails
            pdfDocument={pdfDocument}
            totalPages={totalPages}
            activePage={activePage}
            scrollRoot={scrollRoot}
            onSelect={onSelectPage}
          />
        ) : (
          <PdfOutline entries={outline} activePage={activePage} onSelect={onSelectPage} />
        )}
      </div>
    </aside>
  );
};

export default PdfSidebar;
