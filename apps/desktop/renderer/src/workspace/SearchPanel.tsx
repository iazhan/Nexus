import React, { useEffect, useState } from 'react';
import { isViewerDocumentType, type SearchHit } from '@nexus/core';
import { useLocale } from '../hooks.js';

export interface SearchPanelProps {
  onOpenFile: (filePath: string) => void;
}

type SearchPhase = 'idle' | 'searching' | 'ready' | 'error';

/** 输入停顿多久才真正查询。太短会在连续输入时把索引打满。 */
const DEBOUNCE_MS = 200;

/**
 * 工作区全文搜索面板。
 *
 * 查的是**索引**（磁盘状态），不是当前编辑器内容 —— 全文搜索本来就该覆盖整个工作区。
 * 中文按字切分在后端做（见 ADR-0002），这里只管把查询串原样递过去，
 * **不要**在渲染进程再切一次，否则两套切分逻辑迟早不一致。
 *
 * ## 每条结果三行：文件名 + 路径 + 命中处的上下文
 *
 * 前两行回答「是哪一篇」，第三行才是用户真正要的 —— **它在哪儿提到了我搜的词**。
 * 片段在主进程侧已经摘好并给出了命中词偏移（见 `buildSearchSnippet`），这里只负责
 * 把命中词套一层高亮：一段 100 多字里要不要高亮，决定了用户是「扫一眼」还是「逐行读」。
 *
 * 条目之间用分隔线而不是靠间距：侧栏底色与条目底色接近时，间距分不出边界，
 * 而这两个底色都来自主题 token —— 换个主题就可能撞在一起，间距跟着一起失效。
 */
export const SearchPanel: React.FC<SearchPanelProps> = ({ onOpenFile }) => {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [phase, setPhase] = useState<SearchPhase>('idle');

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      setHits([]);
      setPhase('idle');
      return;
    }

    // 竞态保护：输入变化会取消上一轮。cancelled 同时覆盖「防抖还没触发」和
    // 「已经发出、结果在路上」两种情况 —— 只清 timer 挡不住后者。
    let cancelled = false;
    setPhase('searching');

    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!window.nexus?.searchIndex) {
            throw new Error('搜索接口不可用');
          }
          const results = await window.nexus.searchIndex(trimmed);
          if (cancelled) return;
          setHits(results);
          setPhase('ready');
        } catch (err) {
          if (cancelled) return;
          console.error('Search failed:', err);
          setPhase('error');
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="nexus-search">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.search')}</span>
        {phase === 'ready' && hits.length > 0 && (
          <span className="nexus-sidebar-count">{hits.length}</span>
        )}
      </div>

      <div className="nexus-search-input-row">
        <input
          type="search"
          className="nexus-search-input"
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          value={query}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {phase === 'idle' && <p className="nexus-sidebar-note">{t('search.hint')}</p>}
      {phase === 'searching' && <p className="nexus-sidebar-note">{t('search.searching')}</p>}
      {phase === 'error' && (
        <p className="nexus-sidebar-note nexus-sidebar-error" role="alert">
          {t('search.failed')}
        </p>
      )}
      {phase === 'ready' && hits.length === 0 && (
        <p className="nexus-sidebar-note">{t('search.noResults')}</p>
      )}

      {phase === 'ready' && hits.length > 0 && (
        <ul className="nexus-sidebar-list nexus-search-results">
          {hits.map((hit) => (
            <li key={hit.documentId}>
              <button
                type="button"
                className="nexus-search-hit"
                title={hit.path}
                onClick={() => onOpenFile(hit.path)}
              >
                <span className="nexus-search-hit-title">
                  <span className="nexus-search-hit-name">{hit.name}</span>
                  {/* 类型徽标：PDF / DOCX 的命中来自**正文**（P3-10 提取出来的文本），
                      和 Markdown 的命中不是一回事 —— 不带徽标的话，用户会以为
                      「搜到了文件名」，点进去才发现是内容里的字。
                      判据用 `isViewerDocumentType()`（与侧栏同一套），不写
                      `hit.type !== 'markdown'` —— 将来新增类型时后者会静默漏标。 */}
                  {isViewerDocumentType(hit.type) && (
                    <span className="nexus-search-hit-badge">{t(`document.type.${hit.type}`)}</span>
                  )}
                </span>
                <span className="nexus-search-hit-path">{hit.relativePath}</span>
                {hit.snippet.text.length > 0 && (
                  <span className="nexus-search-hit-snippet">{highlightSnippet(hit)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * 命中词套高亮。**偏移用主进程给的那一份**（`snippet.from` / `to`），这里不再搜一次 ——
 * 再搜一次就得把「哪些词算命中」在渲染进程里再判一遍，而它与 FTS 的分词逻辑故意不同
 * （见 `buildSearchSnippet`：那边管相邻性，这边只定个位）。
 *
 * `from === -1` 表示命中不在正文里（来自标题），整段就是普通片段，不高亮。
 */
function highlightSnippet(hit: SearchHit): React.ReactNode[] {
  const { from, to } = hit.snippet;
  if (from < 0 || to <= from) return [hit.snippet.text];

  return [
    hit.snippet.text.slice(0, from),
    <mark className="nexus-search-hit-mark" key="snippet-mark">
      {hit.snippet.text.slice(from, to)}
    </mark>,
    hit.snippet.text.slice(to)
  ];
}
