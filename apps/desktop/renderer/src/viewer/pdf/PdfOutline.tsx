import React from 'react';
import { useLocale } from '../../hooks.js';

/** 一条已经解析出页码的大纲项。解析不出页码的在主组件里就被丢掉了。 */
export interface PdfOutlineItem {
  readonly title: string;
  /** 0 起。渲染层拿它算缩进。 */
  readonly depth: number;
  readonly page: number;
}

export interface PdfOutlineProps {
  readonly entries: readonly PdfOutlineItem[];
  readonly activePage: number;
  readonly onSelect: (page: number) => void;
}

/** 每层缩进的像素数。 */
const INDENT_PER_LEVEL = 14;

/**
 * PDF 大纲（书签目录）。
 *
 * ## 为什么是平铺的一维列表而不是递归的树
 *
 * pdfjs 给的是树，但这里**不做折叠** —— 大纲本来就是用来一眼扫完的，多一层展开状态
 * 就多一组「我上次展开到哪」的问题。拍平之后 `depth` 只影响缩进，渲染就是一次 `map`。
 *
 * ## 缩进挂在按钮自己身上，不是外层 `<li>`
 *
 * 与编辑器大纲同一条判据：整行（含 hover 底色与点击区域）必须一起右移，
 * 只缩内容会让点击热区仍然横跨整个侧栏宽度 —— 点第 3 层的空白处却跳到别处，
 * 这种错很难在手感上定位。
 */
const PdfOutline: React.FC<PdfOutlineProps> = ({ entries, activePage, onSelect }) => {
  const { t } = useLocale();

  if (entries.length === 0) {
    return <p className="nexus-pdf-sidebar-empty">{t('viewer.pdf.noOutline')}</p>;
  }

  const keys = outlineKeys(entries);

  return (
    <ul className="nexus-pdf-outline">
      {entries.map((entry, index) => (
        <li key={keys[index]}>
          <button
            type="button"
            className="nexus-pdf-outline-item"
            data-depth={entry.depth}
            data-active={entry.page === activePage || undefined}
            style={{ paddingLeft: `${8 + entry.depth * INDENT_PER_LEVEL}px` }}
            title={entry.title}
            onClick={() => onSelect(entry.page)}
          >
            {entry.title}
          </button>
        </li>
      ))}
    </ul>
  );
};

/**
 * 列表键用「身份」而不是下标：`层级:标题:同名序号`。
 *
 * 大纲项没有 id，而**同名条目在一份 PDF 里非常常见**（「图 1-1」在每一章都出现一次）。
 * 只用标题会让两条同名项撞成同一个节点；只加全局下标的话，插进一条新书签会让它之后
 * 所有项的键整体后移，React 于是重建这些节点 —— 而「重建」在有状态的列表里就是状态错位。
 * 加上「同名序号」之后，新插入的项只影响它自己。
 */
function outlineKeys(entries: readonly PdfOutlineItem[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = `${entry.depth}:${entry.title}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return `${base}:${nth}`;
  });
}

export default PdfOutline;
