import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffLine, HistoryEntry } from '@nexus/core';
import type { MarkdownDocumentSession } from '@nexus/editor';
import { useLocale } from '../hooks.js';
import { diffLines } from './line-diff.js';
import { formatSavedAt } from './history-time.js';

export interface HistoryPanelProps {
  /** 当前活动文档的绝对路径；null 表示没有活动文档 */
  filePath: string | null;
  /** 当前文档的 session，用来拿「当前内容」做对比 */
  session: MarkdownDocumentSession | null;
  onRestored: () => void;
  /** 索引/内容变化信号；变化时重读历史 */
  revision: number;
}

/**
 * 版本历史面板：列出历史版本，选中一版看它与**当前内容**的差异。
 *
 * 差异的方向是「历史 → 当前」：`-` 是历史里有而当前没有的，`+` 是当前有而历史里没有的。
 * 这样「恢复这一版」的含义就很直观 —— 它会把 `+` 的行去掉、`-` 的行加回来。
 */
export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  filePath,
  session,
  onRestored,
  revision
}) => {
  const { t } = useLocale();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [historyContent, setHistoryContent] = useState('');
  const [currentContent, setCurrentContent] = useState('');

  // 换文档时清掉选中项：上一份文档的版本对新文档没有意义
  useEffect(() => {
    setSelected(null);
    setHistoryContent('');
  }, [filePath]);

  useEffect(() => {
    if (!filePath) {
      setEntries([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.listHistory?.(filePath)) ?? [];
        if (!cancelled) setEntries(list);
      } catch (err) {
        console.error('Failed to load history:', err);
        if (!cancelled) setEntries([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, revision]);

  // 当前内容跟着 session 走
  useEffect(() => {
    if (!session) {
      setCurrentContent('');
      return;
    }

    setCurrentContent(session.getSnapshot().source);
    return session.subscribe((snapshot) => setCurrentContent(snapshot.source));
  }, [session]);

  const selectEntry = useCallback(
    async (entry: HistoryEntry) => {
      if (!filePath) return;

      setSelected(entry);
      try {
        const content = (await window.nexus?.readHistory?.(filePath, entry)) ?? '';
        setHistoryContent(content);
      } catch (err) {
        console.error('Failed to read history entry:', err);
        setHistoryContent('');
      }
    },
    [filePath]
  );

  const diff = useMemo<DiffLine[]>(
    () => (selected ? diffLines(historyContent, currentContent) : []),
    [selected, historyContent, currentContent]
  );

  const restore = useCallback(async () => {
    if (!filePath || !selected) return;

    try {
      await window.nexus?.restoreHistory?.(filePath, selected);
      onRestored();
    } catch (err) {
      console.error('Failed to restore history entry:', err);
    }
  }, [filePath, selected, onRestored]);

  if (!filePath) {
    return (
      <div className="nexus-history">
        <div className="nexus-sidebar-header">
          <span className="nexus-sidebar-root">{t('history.title')}</span>
        </div>
        <p className="nexus-sidebar-note">{t('history.noDocument')}</p>
      </div>
    );
  }

  return (
    <div className="nexus-history">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('history.title')}</span>
        {entries.length > 0 && <span className="nexus-sidebar-count">{entries.length}</span>}
      </div>

      {entries.length === 0 ? (
        <p className="nexus-sidebar-note">{t('history.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {entries.map((entry) => {
            const isSelected =
              selected?.savedAt === entry.savedAt && selected?.hash === entry.hash;

            return (
              <li key={`${entry.savedAt}-${entry.hash}`}>
                <button
                  type="button"
                  className={`nexus-history-item${isSelected ? ' nexus-history-item-active' : ''}`}
                  onClick={() => void selectEntry(entry)}
                >
                  <span className="nexus-history-time">{formatSavedAt(entry.savedAt)}</span>
                  <span className="nexus-history-hash">{entry.hash}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <div className="nexus-history-diff">
          <div className="nexus-sidebar-header">
            <span className="nexus-sidebar-root">{t('history.diffTitle')}</span>
            <button
              type="button"
              className="nexus-history-restore"
              onClick={() => void restore()}
            >
              {t('history.restore')}
            </button>
          </div>

          <ul className="nexus-history-diff-lines">
            {diff.map((line, index) => (
              <li key={`${index}-${line.kind}`} className={`nexus-diff-${line.kind}`}>
                <span className="nexus-diff-marker">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                </span>
                <span className="nexus-diff-text">{line.text || ' '}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
