import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { rankByFuzzy } from './fuzzy.js';

export interface QuickOpenProps {
  onOpenFile: (filePath: string) => void;
  onClose: () => void;
}

/**
 * 快速打开（Ctrl+P）。
 *
 * 候选来自**索引**而不是已打开的标签页 —— 快速打开的意义正是「打开还没打开的文件」。
 * 所以它自己取一次 `listIndexedDocuments()`，不依赖 App 传参。
 */
export const QuickOpen: React.FC<QuickOpenProps> = ({ onOpenFile, onClose }) => {
  const { t } = useLocale();
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.listIndexedDocuments?.()) ?? [];
        if (!cancelled) setDocuments(list);
      } catch (err) {
        console.error('Quick open failed to load documents:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 挂载即聚焦：Ctrl+P 之后用户想直接打字
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ranked = useMemo(
    () => rankByFuzzy(query, documents, (doc) => doc.relativePath, 50),
    [query, documents]
  );

  // 查询变化后选中项要回到第一条，否则可能停在一个已不存在的下标上
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const commit = useCallback(
    (index: number) => {
      const chosen = ranked[index]?.item;
      if (chosen?.path) onOpenFile(chosen.path);
    },
    [ranked, onOpenFile]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((previous) => Math.min(previous + 1, Math.max(ranked.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((previous) => Math.max(previous - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(activeIndex);
      }
    },
    [activeIndex, commit, onClose, ranked.length]
  );

  return (
    <div className="nexus-quickopen-backdrop" onMouseDown={onClose}>
      {/* 阻止冒泡：点面板内部不该关掉它 */}
      <div
        className="nexus-quickopen"
        role="dialog"
        aria-label={t('quickopen.title')}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="nexus-quickopen-input"
          placeholder={t('quickopen.placeholder')}
          aria-label={t('quickopen.placeholder')}
          value={query}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />

        {ranked.length === 0 ? (
          <p className="nexus-quickopen-empty">
            {documents.length === 0 ? t('quickopen.noIndex') : t('quickopen.noMatch')}
          </p>
        ) : (
          <ul className="nexus-quickopen-list">
            {ranked.map(({ item }, index) => (
              <li key={item.relativePath}>
                <button
                  type="button"
                  className={`nexus-quickopen-item${
                    index === activeIndex ? ' nexus-quickopen-item-active' : ''
                  }`}
                  // onMouseDown 而不是 onClick：backdrop 的 onMouseDown 会先关掉面板
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(index);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="nexus-quickopen-name">{item.name}</span>
                  <span className="nexus-quickopen-path">{item.relativePath}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
