import React, { useEffect, useMemo, useState } from 'react';
import type { MarkdownDocumentSession } from '@nexus/editor';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { extractOutline } from './outline.js';

export interface OutlinePanelProps {
  /** 当前活动文档的 session；大纲跟着它走 */
  session: MarkdownDocumentSession;
  /** 点击标题时跳转到源码偏移 */
  onJump: (offset: number) => void;
  /** 当前文档的绝对路径；反向链接按它查询。null 表示没有活动文档 */
  filePath: string | null;
  /** 点击反向链接时打开对应文档 */
  onOpenFile: (filePath: string) => void;
}

/**
 * 文档大纲面板。
 *
 * 数据来自**当前编辑器的源码**，不是索引 —— 大纲要反映「正在写的这份文本」，
 * 而索引是磁盘状态、天然滞后。所以这里直接订阅 session。
 *
 * 自己订阅而不是让 App 传 `source`：App 的 `session` 是个可变对象，
 * `getSnapshot()` 不触发重渲染，要么在 App 里再加一个「内容版本号」state，
 * 要么就在这里订阅。后者内聚得多，也不用让 App 多背一个状态。
 */
export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  session,
  onJump,
  filePath,
  onOpenFile
}) => {
  const { t } = useLocale();
  const [source, setSource] = useState(() => session.getSnapshot().source);
  const [backlinks, setBacklinks] = useState<IndexedDocument[]>([]);

  useEffect(() => {
    // 换文档（切标签页）时先同步一次，再订阅后续变更
    setSource(session.getSnapshot().source);
    return session.subscribe((snapshot) => {
      setSource(snapshot.source);
    });
  }, [session]);

  // 反向链接只在**换文档**时重查。
  // 编辑当前文档不会改变「谁链接到我」—— 那是别的文档的内容决定的，
  // 而当前文档自身的出链变化由索引器负责，不在这里反映。
  useEffect(() => {
    if (!filePath) {
      setBacklinks([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.findBacklinks?.(filePath)) ?? [];
        if (!cancelled) setBacklinks(list);
      } catch (err) {
        console.error('Failed to load backlinks:', err);
        if (!cancelled) setBacklinks([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const headings = useMemo(() => extractOutline(source), [source]);

  return (
    <div className="nexus-outline">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.outline')}</span>
        {headings.length > 0 && (
          <span className="nexus-sidebar-count">{headings.length}</span>
        )}
      </div>

      {headings.length === 0 ? (
        <p className="nexus-sidebar-note">{t('outline.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {headings.map((heading) => (
            <li key={`${heading.offset}:${heading.level}`}>
              <button
                type="button"
                className={`nexus-outline-item nexus-outline-level-${heading.level}`}
                title={heading.text}
                onClick={() => onJump(heading.offset)}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 反向链接放在大纲下面：两者都是「当前文档的视图」，
          合成一个面板比再加一个活动栏图标更省事，也更贴近使用习惯。 */}
      {filePath && (
        <div className="nexus-backlinks">
          <div className="nexus-sidebar-header">
            <span className="nexus-sidebar-root">{t('backlinks.title')}</span>
            {backlinks.length > 0 && (
              <span className="nexus-sidebar-count">{backlinks.length}</span>
            )}
          </div>

          {backlinks.length === 0 ? (
            <p className="nexus-sidebar-note">{t('backlinks.empty')}</p>
          ) : (
            <ul className="nexus-sidebar-list">
              {backlinks.map((document) => (
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
        </div>
      )}
    </div>
  );
};
