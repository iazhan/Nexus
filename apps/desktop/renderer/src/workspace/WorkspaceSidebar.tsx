import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { buildFileTree, defaultExpandedDirectories, type FileTreeNode } from './tree.js';

export interface WorkspaceSidebarProps {
  rootPath: string;
  activeFilePath: string | null;
  onOpenFile: (filePath: string) => void;
  /**
   * 索引跑完后回调。
   *
   * 需要它的原因：所有面板槽在启动时就一起挂载了，标签面板会在索引建好**之前**
   * 查一次（拿到空结果）。索引完成不体现在 `documentRevision` 里，
   * 所以必须由真正跑索引的这一方明确通知出去。
   */
  onIndexed?: () => void;
}

type IndexPhase = 'indexing' | 'ready' | 'error';

/**
 * 工作区侧栏：列出工作区里的 Markdown 文档。
 *
 * 列表来自**索引**而不是每次扫盘：索引已经建好了（P2-05），查一次是毫秒级的，
 * 而大工作区扫盘要几百毫秒。这也让侧栏天然成为「索引的投影」——
 * 索引是派生数据，删掉重建后侧栏内容不变。
 *
 * 进入时先跑一次 `rebuildIndex()`：它是幂等的（内容哈希没变就跳过），
 * 所以每次进工作区都跑一遍是安全的，不需要额外的「是否已建过索引」状态。
 */
export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  rootPath,
  activeFilePath,
  onOpenFile,
  onIndexed
}) => {
  const { t } = useLocale();
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [phase, setPhase] = useState<IndexPhase>('indexing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onIndexedRef = useRef(onIndexed);
  onIndexedRef.current = onIndexed;

  useEffect(() => {
    let cancelled = false;

    setPhase('indexing');
    setErrorMessage(null);

    void (async () => {
      try {
        if (!window.nexus?.rebuildIndex || !window.nexus?.listIndexedDocuments) {
          throw new Error('索引接口不可用');
        }

        const result = await window.nexus.rebuildIndex(rootPath);
        if (cancelled) return;

        // 单个文件读不动不该让侧栏整块失败，但要让人看见
        if (result.errors.length > 0) {
          console.warn('[Nexus] 部分文件索引失败:', result.errors);
        }

        const list = await window.nexus.listIndexedDocuments();
        if (cancelled) return;

        setDocuments(list);
        setPhase('ready');

        // 通过 ref 调用：直接依赖 onIndexed 会让它进入 effect 的依赖数组，
        // 父组件每次渲染传新函数就会重新触发整次索引。
        onIndexedRef.current?.();
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const tree = useMemo(() => buildFileTree(documents), [documents]);

  /** 已展开的目录（按 relativePath）。目录不对应磁盘实体，所以只能用它当 key。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expansionInitialized, setExpansionInitialized] = useState(false);

  // 首次拿到文档时套用默认展开（只展开顶层）。之后**不覆盖**用户的展开状态 ——
  // 索引刷新会重建 tree，如果每次都重置展开，用户刚展开的目录会莫名收起来。
  useEffect(() => {
    if (expansionInitialized || tree.length === 0) return;
    setExpanded(defaultExpandedDirectories(tree));
    setExpansionInitialized(true);
  }, [tree, expansionInitialized]);

  const toggleDirectory = useCallback((relativePath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  }, []);

  /** 递归渲染。缩进用 depth 算，不做嵌套 DOM —— 嵌套会让长文件名的省略号算错宽度。 */
  const renderNodes = (nodes: readonly FileTreeNode[], depth: number): React.ReactNode => (
    <ul className="nexus-tree-list">
      {nodes.map((node) => {
        if (node.type === 'directory') {
          const isOpen = expanded.has(node.relativePath);
          return (
            <li key={`d:${node.relativePath}`}>
              <button
                type="button"
                className="nexus-tree-item nexus-tree-dir"
                style={{ paddingLeft: 8 + depth * 12 }}
                aria-expanded={isOpen}
                onClick={() => toggleDirectory(node.relativePath)}
              >
                <span
                  className={`nexus-tree-chevron${isOpen ? ' nexus-tree-chevron-open' : ''}`}
                  aria-hidden="true"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </span>
                <span className="nexus-tree-name">{node.name}</span>
              </button>
              {isOpen && renderNodes(node.children, depth + 1)}
            </li>
          );
        }

        const isActive = node.path === activeFilePath;
        return (
          <li key={`f:${node.relativePath}`}>
            <button
              type="button"
              className={`nexus-tree-item nexus-tree-file${
                isActive ? ' nexus-tree-item-active' : ''
              }`}
              // 文件比同级目录多缩进一档，让它们看起来「装在」目录里
              style={{ paddingLeft: 8 + depth * 12 + 14 }}
              title={node.path ?? node.relativePath}
              onClick={() => {
                if (node.path) onOpenFile(node.path);
              }}
            >
              <span className="nexus-tree-name">{node.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside
      className="nexus-workspace-sidebar"
      data-phase={phase}
      aria-label={t('workspace.title')}
    >
      <div className="nexus-sidebar-header" title={rootPath}>
        <span className="nexus-sidebar-root">{rootPath.replace(/^.*[\\/]/, '') || rootPath}</span>
        {phase === 'ready' && (
          <span className="nexus-sidebar-count">
            {t('workspace.fileCount', { count: String(documents.length) })}
          </span>
        )}
      </div>

      {phase === 'indexing' && <p className="nexus-sidebar-note">{t('workspace.indexing')}</p>}

      {phase === 'error' && (
        <p className="nexus-sidebar-note nexus-sidebar-error" role="alert">
          {t('workspace.indexFailed')}
          {errorMessage ? `：${errorMessage}` : ''}
        </p>
      )}

      {phase === 'ready' && tree.length === 0 && (
        <p className="nexus-sidebar-note">{t('workspace.noFiles')}</p>
      )}

      {phase === 'ready' && tree.length > 0 && (
        <div className="nexus-tree-scroll">{renderNodes(tree, 0)}</div>
      )}
    </aside>
  );
};
