import React, { useEffect, useMemo, useState } from 'react';
import type { MarkdownDocumentSession } from '@nexus/editor';
import { useLocale } from '../hooks.js';
import { extractOutline } from './outline.js';

export interface OutlinePanelProps {
  /** 当前活动文档的 session；大纲跟着它走 */
  session: MarkdownDocumentSession;
  /** 点击标题时跳转到源码偏移 */
  onJump: (offset: number) => void;
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
export const OutlinePanel: React.FC<OutlinePanelProps> = ({ session, onJump }) => {
  const { t } = useLocale();
  const [source, setSource] = useState(() => session.getSnapshot().source);

  useEffect(() => {
    // 换文档（切标签页）时先同步一次，再订阅后续变更
    setSource(session.getSnapshot().source);
    return session.subscribe((snapshot) => {
      setSource(snapshot.source);
    });
  }, [session]);

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
    </div>
  );
};
