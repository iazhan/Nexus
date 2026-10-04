import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { rankByFuzzy } from './fuzzy.js';

export interface InsertLinkPaletteProps {
  /** 挑中了一篇文档。调用方负责按当前链接格式拼字符串并插到光标处。 */
  onPick: (document: IndexedDocument) => void;
  onClose: () => void;
}

/**
 * 插入链接的选目标面板。
 *
 * ## 为什么不复用 `QuickOpen`
 *
 * 交互形状完全一样（输入 → 模糊过滤 → 上下键 → 回车），但**挑中之后做什么**是两件事：
 * 那边是「打开这篇」，这边是「把链接插到光标处、面板关掉、文档一行都不动」。
 * 把两种语义塞进一个组件的代价是给它加一个 `mode` 分支，而两个分支的 props、
 * 文案、确认后的副作用全都不同 —— 那种组件比两份 100 行的实现更难读。
 * 共用的是 **CSS**（`.nexus-insert-link-*` 与 `.nexus-quickopen-*` 在 `App.css` 里
 * 是同一组声明）与 `rankByFuzzy`，那才是真正重复的部分。
 *
 * ## 候选来自索引
 *
 * 与快速打开同一条：插入链接的意义是「链到工作区里任意一篇」，包括还没打开的。
 * 所以它自己取一次 `listIndexedDocuments()`，不依赖 App 传参。
 *
 * ## 焦点与关闭
 *
 * 挂载即聚焦输入框（打开面板就是为了打字）。`Escape` 关闭，点遮罩关闭；
 * 面板内部按下要 `stopPropagation`，否则点列表项会先被遮罩的 `onMouseDown` 关掉。
 */
export const InsertLinkPalette: React.FC<InsertLinkPaletteProps> = ({ onPick, onClose }) => {
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
        console.error('Insert link failed to load documents:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
      if (chosen?.path) onPick(chosen);
    },
    [ranked, onPick]
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
    <div className="nexus-insert-link-backdrop" onMouseDown={onClose}>
      {/* 阻止冒泡：点面板内部不该关掉它 */}
      <div
        className="nexus-insert-link"
        role="dialog"
        data-insert-link-palette=""
        aria-label={t('insertLink.title')}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="nexus-insert-link-input"
          placeholder={t('insertLink.placeholder')}
          aria-label={t('insertLink.placeholder')}
          value={query}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />

        {ranked.length === 0 ? (
          <p className="nexus-insert-link-empty">
            {documents.length === 0 ? t('insertLink.noIndex') : t('insertLink.noMatch')}
          </p>
        ) : (
          <ul className="nexus-insert-link-list">
            {ranked.map(({ item }, index) => (
              <li key={item.relativePath}>
                <button
                  type="button"
                  className={`nexus-insert-link-item${
                    index === activeIndex ? ' nexus-insert-link-item-active' : ''
                  }`}
                  data-insert-link-item={item.relativePath}
                  // onMouseDown 而不是 onClick：backdrop 的 onMouseDown 会先关掉面板
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(index);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="nexus-insert-link-name">{item.name}</span>
                  <span className="nexus-insert-link-path">{item.relativePath}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
