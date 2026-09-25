import React, { useEffect, useState } from 'react';
import type { SearchHit } from '@nexus/core';
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
        <ul className="nexus-sidebar-list">
          {hits.map((hit) => (
            <li key={hit.documentId}>
              <button
                type="button"
                className="nexus-search-hit"
                title={hit.path}
                onClick={() => onOpenFile(hit.path)}
              >
                <span className="nexus-search-hit-name">{hit.name}</span>
                <span className="nexus-search-hit-path">{hit.relativePath}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
