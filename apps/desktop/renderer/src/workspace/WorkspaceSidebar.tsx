import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { hostSettingsSynced } from '../host-settings.js';
import {
  buildAttachmentGroups,
  extractionNoteOf,
  splitIndexedDocuments,
  type AttachmentGroup
} from './attachments.js';
import { formatFileSize } from './file-size.js';
import { formatTimestamp } from './time-format.js';
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

/** 折叠箭头。目录与附件分组共用，所以抽出来 —— 两份内联 SVG 迟早会改歪一个。 */
const CHEVRON = (
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
);

/**
 * 工作区侧栏：**笔记树 + 附件区**两段（UI 蓝图 §8.1）。
 *
 * 列表来自**索引**而不是每次扫盘：索引已经建好了（P2-05），查一次是毫秒级的，
 * 而大工作区扫盘要几百毫秒。这也让侧栏天然成为「索引的投影」——
 * 索引是派生数据，删掉重建后侧栏内容不变。
 *
 * 进入时先跑一次 `rebuildIndex()`：它是幂等的（内容哈希没变就跳过），
 * 所以每次进工作区都跑一遍是安全的，不需要额外的「是否已建过索引」状态。
 *
 * ## 为什么分两段（P3-09）
 *
 * P3-04 把附件纳入索引之后，附件就一直和 `.md` 混在同一棵树里 —— 当时是自洽的
 * （P3-05 的打开分流让它真的能点开），但「500 张图平铺在笔记树里」显然不是终态。
 * 现在按 §8.1 拆成两段：**笔记树只装 Markdown**，附件进独立的附件区按类型分组。
 *
 * 两段的判据由 `splitIndexedDocuments()` 给出（附件用 `isViewerDocumentType()` 正向判定），
 * 这里只负责渲染 —— 分类规则是纯函数，有单测。
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

        // 等宿主设置送到主进程**再**建索引：跳过规则是在主进程的 walker 里生效的，
        // 抢在前面跑会让第一次索引用上旧规则（症状是「填了忽略规则，第一次没生效」）。
        await hostSettingsSynced();
        if (cancelled) return;

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

  const { notes, attachments } = useMemo(() => splitIndexedDocuments(documents), [documents]);
  const tree = useMemo(() => buildFileTree(notes), [notes]);
  const groups = useMemo(() => buildAttachmentGroups(attachments), [attachments]);

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

  /**
   * 被收起的附件分组。
   *
   * 存「收起」而不是「展开」：分组固定就那么几个（`VIEWER_DOCUMENT_TYPES`），
   * 默认全部展开更符合直觉，于是不需要一个「首次拿到数据时把默认值写进 state」
   * 的 effect —— 那种 effect 正是笔记树那边 `expansionInitialized` 存在的原因。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const toggleGroup = useCallback((type: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  /** 递归渲染笔记树。缩进用 depth 算，不做嵌套 DOM —— 嵌套会让长文件名的省略号算错宽度。 */
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
                  {CHEVRON}
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

  /** 一个附件分组：可折叠的标题 + 组内的附件行。 */
  const renderGroup = (group: AttachmentGroup): React.ReactNode => {
    const isOpen = !collapsedGroups.has(group.type);
    return (
      <li key={`g:${group.type}`}>
        <button
          type="button"
          className="nexus-tree-item nexus-tree-dir nexus-attachment-group"
          style={{ paddingLeft: 8 }}
          aria-expanded={isOpen}
          onClick={() => toggleGroup(group.type)}
        >
          <span
            className={`nexus-tree-chevron${isOpen ? ' nexus-tree-chevron-open' : ''}`}
            aria-hidden="true"
          >
            {CHEVRON}
          </span>
          {/* 组标题直接复用 `document.type.*` —— 类型的中英名只留一处，
              不在这里再写一遍「图片 / Images」。 */}
          <span className="nexus-tree-name">{t(`document.type.${group.type}`)}</span>
          <span className="nexus-attachment-count">{group.entries.length}</span>
        </button>

        {isOpen && (
          <ul className="nexus-tree-list">
            {group.entries.map((entry) => {
              const isActive = entry.document.path === activeFilePath;
              const modifiedAt = formatTimestamp(entry.document.modifiedAtMs);
              // 只有「本该有文本却没提到」与「提取失败」会给出提示；`'none'`
              // （图片、或这一轮没被引用）与 `'extracted'` 都是静默的。
              const extractionNote = extractionNoteOf(entry.document);

              // tooltip 逐条拼：`stat` 失败时 `formatTimestamp` 给空串，
              // 不要多出一个空行；没有提取提示时也不要。
              const tooltipLines = [entry.document.path];
              if (modifiedAt) tooltipLines.push(modifiedAt);
              if (extractionNote !== null) {
                tooltipLines.push(t(`workspace.extraction.${extractionNote}`));
              }

              return (
                <li key={entry.document.path}>
                  <button
                    type="button"
                    className={`nexus-tree-item nexus-tree-file nexus-attachment-item${
                      isActive ? ' nexus-tree-item-active' : ''
                    }`}
                    // 与目录下的文件同一档缩进（分组标题算作「目录」那一层）
                    style={{ paddingLeft: 8 + 14 }}
                    // 修改时间与提取结果都放 tooltip 而不是行内：行宽有限，而这两样
                    // 都是「要判断时才需要」的信息。行内只留一个短标记（见下）。
                    title={tooltipLines.join('\n')}
                    onClick={() => onOpenFile(entry.document.path)}
                  >
                    {/* 名字复用 `.nexus-tree-name`：附件行和笔记行都是「树里的一行」，
                        另起一个名字类只会让「按名字找条目」的查询多写一个选择器。 */}
                    <span className="nexus-tree-name">{entry.document.name}</span>
                    {/* 同名才显示的目录提示：值为空串表示「就在工作区根目录」 */}
                    {entry.directoryHint !== null && (
                      <span className="nexus-attachment-hint">
                        {entry.directoryHint.length > 0
                          ? entry.directoryHint
                          : t('workspace.attachmentRoot')}
                      </span>
                    )}
                    {/* 行内只放短标记：侧栏很窄，「未提取到文本」会把文件名挤掉。
                        完整说法在按钮的 tooltip 里（上面那三行）。
                        用文本而不是图标 —— 图标在这个项目里没有先例，而一个没有
                        图例的符号只会让人猜。 */}
                    {extractionNote !== null && (
                      <span className={`nexus-attachment-note nexus-attachment-note-${extractionNote}`}>
                        {t(`workspace.extraction.${extractionNote}Short`)}
                      </span>
                    )}
                    <span className="nexus-attachment-size">
                      {formatFileSize(entry.document.sizeBytes)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

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

      {/* 一个文档都没有时才整块空 —— 只有附件没有笔记是有内容的状态，
          那时两段各自的空态更准确（「还没有笔记」而不是「没有文档」）。 */}
      {phase === 'ready' && documents.length === 0 && (
        <p className="nexus-sidebar-note">{t('workspace.noFiles')}</p>
      )}

      {phase === 'ready' && documents.length > 0 && (
        <div className="nexus-tree-scroll">
          <section
            className="nexus-sidebar-section"
            data-section="notes"
            aria-label={t('workspace.sectionNotes')}
          >
            <div className="nexus-sidebar-section-title">
              <span>{t('workspace.sectionNotes')}</span>
              <span className="nexus-sidebar-section-count">{notes.length}</span>
            </div>
            {tree.length === 0 ? (
              <p className="nexus-sidebar-note">{t('workspace.noNotes')}</p>
            ) : (
              renderNodes(tree, 0)
            )}
          </section>

          <section
            className="nexus-sidebar-section"
            data-section="attachments"
            aria-label={t('workspace.sectionAttachments')}
          >
            <div className="nexus-sidebar-section-title">
              <span>{t('workspace.sectionAttachments')}</span>
              <span className="nexus-sidebar-section-count">{attachments.length}</span>
            </div>
            {groups.length === 0 ? (
              <p className="nexus-sidebar-note">{t('workspace.noAttachments')}</p>
            ) : (
              <ul className="nexus-tree-list">{groups.map(renderGroup)}</ul>
            )}
          </section>
        </div>
      )}
    </aside>
  );
};
