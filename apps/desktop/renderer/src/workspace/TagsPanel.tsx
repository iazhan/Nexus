import React, { useEffect, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';

export interface TagsPanelProps {
  onOpenFile: (filePath: string) => void;
  /** 索引变化信号；变化时重读标签列表 */
  revision: number;
}

/**
 * 标签面板。
 *
 * 列出所有标签及文档数，点开某个标签才去查它的文档 ——
 * 一次性把所有标签的文档都拉回来，在标签多、文档多的工作区里是纯浪费。
 */
export const TagsPanel: React.FC<TagsPanelProps> = ({ onOpenFile, revision }) => {
  const { t } = useLocale();
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.listTags?.()) ?? [];
        if (!cancelled) setTags(list);
      } catch (err) {
        console.error('Failed to load tags:', err);
        if (!cancelled) setTags([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    if (!expandedTag) {
      setDocuments([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.findDocumentsByTag?.(expandedTag)) ?? [];
        if (!cancelled) setDocuments(list);
      } catch (err) {
        console.error('Failed to load documents for tag:', err);
        if (!cancelled) setDocuments([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expandedTag, revision]);

  return (
    <div className="nexus-tags">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.tags')}</span>
        {tags.length > 0 && <span className="nexus-sidebar-count">{tags.length}</span>}
      </div>

      {tags.length === 0 ? (
        <p className="nexus-sidebar-note">{t('tags.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {tags.map(({ tag, count }) => {
            const isExpanded = expandedTag === tag;
            return (
              <li key={tag}>
                <button
                  type="button"
                  className={`nexus-tag-item${isExpanded ? ' nexus-tag-item-active' : ''}`}
                  aria-expanded={isExpanded}
                  title={`#${tag}`}
                  onClick={() => setExpandedTag((previous) => (previous === tag ? null : tag))}
                >
                  <span className="nexus-tag-name">#{tag}</span>
                  <span className="nexus-tag-count">{count}</span>
                </button>

                {isExpanded && (
                  <ul className="nexus-tag-documents">
                    {documents.map((document) => (
                      <li key={document.id}>
                        <button
                          type="button"
                          className="nexus-backlink-item"
                          title={document.path}
                          onClick={() => onOpenFile(document.path)}
                        >
                          {document.relativePath}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
