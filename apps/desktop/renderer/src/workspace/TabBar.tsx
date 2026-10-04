import React from 'react';
import { hasUnsavedChanges, type WorkspaceDocument } from './store.js';
import { useLocale } from '../hooks.js';

export interface TabBarProps {
  documents: readonly WorkspaceDocument[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * 多标签页栏。
 *
 * 只渲染「打开了几个文档」这一件事，所有状态都从 props 来 ——
 * 它不持有任何文档状态，所以不存在和 WorkspaceStore 漂移的可能。
 *
 * P3-05 起两类文档共用这一条栏：可编辑 Markdown 与只读附件（pdf / docx / 图片）。
 * 它们**必须**在同一个列表里，否则「打开了一个 PDF」在界面上没有任何痕迹 ——
 * 而用户明明刚双击了它。区分信息由文件名自带（`stm32.pdf` vs `stm32.md`），
 * 脏点则天然只出现在可编辑文档上（附件的 saveState 恒为 `readonly`）。
 *
 * **只有一个文档时也渲染。** 此前是 `<= 1` 直接 `return null`，理由是「占一行高度但信息量为零」；
 * 改成常驻之后，编辑区不会因为开了第二个文档、或关到只剩一个而突然多出/少掉一行。
 * 代价是单文档时白占一行 —— 这是取舍，不是遗漏。
 *
 * **零个文档才不渲染**：那时没有可点的东西，而主区本来就在画空态。
 *
 * 脏点读 `hasUnsavedChanges()` 而不是在这里再列一遍保存态：那个集合是「缓冲区里有磁盘上
 * 没有的东西」，与关标签页前要不要先落盘、改名要跳过哪些文档是同一条判据 —— 列两遍，
 * 将来加一个保存态就会漏掉一处。
 */
export const TabBar: React.FC<TabBarProps> = ({
  documents,
  activeId,
  onActivate,
  onClose
}) => {
  const { t } = useLocale();

  if (documents.length === 0) return null;

  return (
    <div className="nexus-tab-bar" role="tablist">
      {documents.map((document) => {
        const name = document.filePath
          ? document.filePath.replace(/^.*[\\/]/, '')
          : t('tab.untitled');
        const isActive = document.id === activeId;
        const isUnsaved = hasUnsavedChanges(document);

        return (
          <div
            key={document.id}
            role="tab"
            aria-selected={isActive}
            // 供 E2E 区分两类标签：DOM 上看不出「这条是只读的」，
            // 而「附件进的是同一份标签页集合」正是 P3-05 的核心不变量。
            data-document-kind={document.kind}
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
