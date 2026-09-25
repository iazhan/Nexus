import React from 'react';
import type { WorkspaceDocument } from './store.js';
import { useLocale } from '../hooks.js';

export interface TabBarProps {
  documents: readonly WorkspaceDocument[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * 未落盘的状态集合。
 *
 * `saving` 也算 —— 保存还没落地就关掉标签页，等于把这次编辑丢了。
 * 用集合而不是 `!== 'clean'`：`readonly` 是「干净但不可写」，不该显示未保存点。
 */
const UNSAVED_STATES = new Set(['dirty', 'saving', 'error', 'external-changed']);

/**
 * 多标签页栏。
 *
 * 只渲染「打开了几个文档」这一件事，所有状态都从 props 来 ——
 * 它不持有任何文档状态，所以不存在和 WorkspaceStore 漂移的可能。
 */
export const TabBar: React.FC<TabBarProps> = ({
  documents,
  activeId,
  onActivate,
  onClose
}) => {
  const { t } = useLocale();

  // 只有一个标签页时不占那一行高度：信息量为零，却要吃掉编辑区
  if (documents.length <= 1) return null;

  return (
    <div className="nexus-tab-bar" role="tablist">
      {documents.map((document) => {
        const name = document.filePath
          ? document.filePath.replace(/^.*[\\/]/, '')
          : t('tab.untitled');
        const isActive = document.id === activeId;
        const isUnsaved = UNSAVED_STATES.has(document.saveState);

        return (
          <div
            key={document.id}
            role="tab"
            aria-selected={isActive}
            className={`nexus-tab${isActive ? ' nexus-tab-active' : ''}`}
            title={document.filePath ?? name}
            onClick={() => onActivate(document.id)}
            // 鼠标中键关闭：浏览器与主流编辑器的通行行为
            onAuxClick={(event) => {
              if (event.button === 1) onClose(document.id);
            }}
          >
            {isUnsaved && <span className="nexus-tab-dot" aria-hidden="true" />}
            <span className="nexus-tab-name">{name}</span>
            <button
              type="button"
              className="nexus-tab-close"
              aria-label={t('tab.close', { name })}
              onClick={(event) => {
                event.stopPropagation();
                onClose(document.id);
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
};
