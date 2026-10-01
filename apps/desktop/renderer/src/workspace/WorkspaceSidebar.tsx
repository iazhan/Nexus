import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexedDocument, WorkspaceDirectoryEntry } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { hostSettingsSynced } from '../host-settings.js';
import {
  AttachmentRowIcon,
  ChevronIcon,
  FolderRowIcon,
  NoteRowIcon,
  RetryIcon
} from '../components/workspace-icons.js';
import { InlineRename } from './InlineRename.js';
import { NewEntryInput } from './NewEntryInput.js';
import { extractionNoteOf } from './attachments.js';
import { formatFileSize } from './file-size.js';
import { formatTimestamp } from './time-format.js';
import {
  buildFileTree,
  collectDirectoryPaths,
  defaultExpandedDirectories,
  findParentDirectory,
  findTreeNode,
  findTreeNodeByPath,
  isAttachmentNode,
  type FileTreeNode
} from './tree.js';
import { filterTreeByImageVisibility } from './tree-filter.js';
import { WorkspaceToolbar } from './workspace-toolbar.js';

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
  /**
   * 在某一行上按了右键。**只上报节点与位置，不自己开菜单** ——
   * 菜单项要做的事（新建、删除、重命名、复制链接）都要用文档 store 与 IPC 桥，
   * 而那些都在 `App` 手里。侧栏保持「只渲染、只上报」的形状。
   *
   * 坐标是 `MouseEvent.clientX/clientY`（视口坐标）：菜单是 `position: fixed` 的。
   */
  onNodeContextMenu?: (node: FileTreeNode, x: number, y: number) => void;
  /**
   * 外部知道「索引里的文档集合变了」时递增它（删掉一个文件、重命名之后会用）。
   *
   * 只**重读列表**，不重建索引 —— 重建是开工作区那一次的事（几百毫秒），
   * 而这里要处理的只是点状变化。与标签 / 图谱面板共用 `documentRevision` 这个信号。
   */
  revision?: number;
  /** 正在内联改名的文件（绝对路径）。`null` ＝ 没有在改名。 */
  renamingPath?: string | null;
  onRenameCommit?: (filePath: string, newName: string) => void;
  onRenameCancel?: () => void;

  // ---- 工作区工具栏（2026-10-01）----
  /** 「显示图片」开关的当前值。这是**视图状态**，不是设置项。 */
  showImages: boolean;
  onShowImagesChange(next: boolean): void;
  /**
   * 在某个目录下新建文件。成功时返回**新文件的绝对路径**，失败返回 `null`。
   *
   * 返回路径而不是一个布尔：新建之后要把选中项挪到那个新文件上，而「新文件叫什么」
   * 只有主进程知道（没写扩展名时它补 `.md`）。不挪的话，工具栏的「删除」会继续打在
   * **上一个**选中的文件上 —— 用户刚看见新文件被打开、高亮着，点删除却删了别的，
   * 那是数据丢失级的不一致。
   */
  onCreateFile: (directoryPath: string, name: string) => Promise<string | null>;
  /** 同上，返回新目录的绝对路径。 */
  onCreateFolder: (directoryPath: string, name: string) => Promise<string | null>;
  onDeleteFile: (filePath: string) => void;
  /** 重新扫描工作区（重扫目录 + 重建索引）。列表由侧栏自己重读。 */
  onRefresh: () => Promise<void>;
  /**
   * 外部（目录行的右键菜单）要求「在这个目录里开始新建」。
   *
   * 为什么不能沿用工具栏那套「按选中项推落点」：右键菜单在 `App` 手里，而落点要精确到
   * **被右键的那个目录**。右键确实也会把选中项设成那个目录，但那是「顺带」——
   * 让菜单项去依赖一个它看不见的副作用，等于把两件事绑在一起。
   *
   * 处理完必须调 `onCreateRequestHandled` 把它清掉，否则它会一直被当成「新的请求」。
   */
  createRequest?: { kind: 'file' | 'folder'; parentRelativePath: string } | null;
  onCreateRequestHandled?: () => void;
}

type IndexPhase = 'indexing' | 'ready' | 'error';

/** 正在新建的东西：落在哪个目录（相对路径 `null` ＝ 工作区根）与它的绝对路径。 */
interface CreatingState {
  kind: 'file' | 'folder';
  parentRelativePath: string | null;
  parentPath: string;
}

/**
 * 工作区侧栏：**一棵树**（笔记与附件混排）+ 一行工具栏。
 *
 * ## 为什么不再分两段（2026-10-01 改）
 *
 * P3-09 把附件拆进独立的「附件区」，理由是「500 张图平铺在笔记树里不是终态」。
 * 那个判断错在**把附件当成了另一种东西** —— 工作区从立项起就是「可以浏览多种格式
 * 文档」的地方，`.png` 与 `.md` 都是这个工作区里的文件。两个参考实现
 * （Markra、OpenKnowledge）也都是单树 + 一个可见性开关。
 *
 * 拆成两段还有一个现在才显出来的代价：附件区按类型分组、**不保留目录结构**，
 * 于是同一张图在「笔记树」与「附件区」里是两条不同的路径 —— 而树的全部意义
 * 恰恰在于「它在哪个目录下」。
 *
 * ## 树的数据源是**两路**
 *
 * 文件来自索引（元数据、类型、提取状态只有它有），目录来自磁盘
 * （`listWorkspaceDirectories` —— 索引里只有文件，空目录在它眼里不存在）。
 * 两路在 `buildFileTree` 里合流。
 *
 * ## 状态展示仍然单一派生
 *
 * `phase` 是唯一的分支依据；空态、错误态、滤空态都从它加上树本身派生，不另设布尔。
 */
export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  rootPath,
  activeFilePath,
  onOpenFile,
  onIndexed,
  onNodeContextMenu,
  revision,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
  showImages,
  onShowImagesChange,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onRefresh,
  createRequest,
  onCreateRequestHandled
}) => {
  const { t } = useLocale();
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [directories, setDirectories] = useState<WorkspaceDirectoryEntry[]>([]);
  const [phase, setPhase] = useState<IndexPhase>('indexing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onIndexedRef = useRef(onIndexed);
  onIndexedRef.current = onIndexed;

  /** 只重读两份列表，不碰索引。挂载、刷新、外部改动三条路都走它。 */
  const readLists = useCallback(async () => {
    const [list, dirs] = await Promise.all([
      window.nexus?.listIndexedDocuments?.() ?? Promise.resolve([]),
      window.nexus?.listWorkspaceDirectories?.(rootPath) ?? Promise.resolve([])
    ]);
    return { list, dirs };
  }, [rootPath]);

  const applyLists = useCallback(
    (next: { list: IndexedDocument[]; dirs: WorkspaceDirectoryEntry[] }) => {
      setDocuments(next.list);
      setDirectories(next.dirs);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    setPhase('indexing');
    setErrorMessage(null);
    // 换工作区要把「默认展开」重新套一遍，否则新工作区的顶层目录全是收着的
    setExpansionInitialized(false);
    setSelected(null);
    setCreating(null);

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

        applyLists(await readLists());
        if (cancelled) return;

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
  }, [rootPath, readLists, applyLists]);

  /**
   * 文档集合变了（删掉、重命名、新建）时重读列表。
   *
   * 跳过挂载那一次：上面那个 effect 已经在建完索引后读过一遍，这里再读一次是白读 ——
   * 而且它会**和上面那个抢**：索引还没建完就查，拿到的是旧列表，
   * 谁后 resolve 谁说了算。跳过首跑，这个竞态就不存在。
   */
  const revisionSkippedRef = useRef(false);
  useEffect(() => {
    if (!revisionSkippedRef.current) {
      revisionSkippedRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const next = await readLists();
        if (!cancelled) applyLists(next);
      } catch {
        // 重读失败就保持原样：下一次开工作区会重建索引，不值得为它把侧栏打成错误态
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision, readLists, applyLists]);

  const tree = useMemo(() => buildFileTree({ documents, directories }), [documents, directories]);

  /**
   * 树里到底有多少张图 —— 决定工具栏那枚开关要不要出现。
   *
   * 判的是**图片**不是「附件」：这个开关的意图是「树被图淹了」，而 PDF / DOCX
   * 通常是找的目标。见 `tree-filter.ts`。
   */
  const imageCount = useMemo(
    () => filterTreeByImageVisibility(tree, false).hiddenImageCount,
    [tree]
  );

  const visibleTree = useMemo(
    () => (showImages ? tree : filterTreeByImageVisibility(tree, false).nodes),
    [tree, showImages]
  );

  /** 已展开的目录（按 relativePath）。目录不对应唯一磁盘实体，所以只能用它当 key。 */
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
   * 树里所有目录。「全部展开 / 收起」的判据与动作都从它算 —— 同源，见 `collectDirectoryPaths`。
   *
   * 用的是**整棵树**而不是过滤后的可见树：按钮叫「全部展开」，那它就该管全部。
   * 按可见树算的话，「收起全部」之后把图片放出来，会看到 `assets/` 还开着 ——
   * 而用户刚才明明按了「全部收起」。
   */
  const directoryPaths = useMemo(() => collectDirectoryPaths(tree), [tree]);

  const allExpanded =
    directoryPaths.length > 0 && directoryPaths.every((path) => expanded.has(path));

  const toggleExpandAll = useCallback(() => {
    setExpanded((previous) => {
      const everyExpanded = directoryPaths.every((path) => previous.has(path));
      // 收起时整份清空而不是逐个删：空集合就是「只有顶层展开」的起点，
      // 而逐个删会把「用户手动展开过、后来又收起来的中间态」留在集合里。
      return everyExpanded ? new Set<string>() : new Set(directoryPaths);
    });
  }, [directoryPaths]);

  /**
   * 树上「被选中的那一行」。
   *
   * 工具栏的「删除」需要一个作用对象，而 `activeFilePath`（当前打开的文档）不是
   * 「选中」—— 用户完全可能选中 A 去删，而编辑器里开着 B。两者不一致的后果是删错
   * 文件，所以**选中态与按钮可用性必须同源**。
   */
  const [selected, setSelected] = useState<FileTreeNode | null>(null);

  /**
   * 刚建好的东西的绝对路径 —— 等它出现在树里之后选中它。
   *
   * 为什么不能建完直接选中：那时树还是旧的（列表要重读一次），新节点根本不在里面。
   * 用 ref 而不是 state：它不参与渲染，只是一个「等下一次 tree 更新时用一次」的记号。
   */
  const pendingSelectRef = useRef<string | null>(null);

  useEffect(() => {
    const target = pendingSelectRef.current;
    if (target === null) return;
    const node = findTreeNodeByPath(tree, target);
    if (!node) return;
    pendingSelectRef.current = null;
    setSelected(node);
  }, [tree]);

  // 选中项从树里消失时自动清掉：删掉文件、外部改动、切工作区都会走到这里。
  // 自愈而不是在每条删除路径上手工清 —— 手工清总会漏一条（比如外部删的）。
  useEffect(() => {
    if (!selected) return;
    if (!findTreeNode(tree, selected.relativePath)) setSelected(null);
  }, [tree, selected]);

  /** 新建的落点：选中目录 → 它；选中文件 → 它所在的目录；没选中 → 工作区根。 */
  const creationDirectory = useMemo((): { relativePath: string | null; path: string } => {
    if (!selected) return { relativePath: null, path: rootPath };

    const directory =
      selected.type === 'directory' ? selected : findParentDirectory(tree, selected.relativePath);

    // 目录列举是两路数据源里可能过期的那一路，所以补出来的目录 `path` 会是 `null`。
    // 落到根是刻意的降级：宁可建在用户看得见的地方，也不要拿一个不存在的目录去建。
    if (!directory || directory.path === null) return { relativePath: null, path: rootPath };

    return { relativePath: directory.relativePath, path: directory.path };
  }, [selected, tree, rootPath]);

  const [creating, setCreating] = useState<CreatingState | null>(null);

  /** 开始新建：落点显式给，不在这里推 —— 两个入口（工具栏、右键菜单）各推各的。 */
  const beginCreating = useCallback(
    (kind: 'file' | 'folder', parentRelativePath: string | null, parentPath: string) => {
      setCreating({ kind, parentRelativePath, parentPath });

      // 落点在一个收着的目录里时先展开它 —— 否则输入行画在一个看不见的地方
      if (parentRelativePath !== null) {
        const target = parentRelativePath;
        setExpanded((previous) => new Set(previous).add(target));
      }
    },
    []
  );

  /** 工具栏入口：落点按选中项推（选中目录 → 它；选中文件 → 它所在目录；没选中 → 根）。 */
  const startCreating = useCallback(
    (kind: 'file' | 'folder') => {
      beginCreating(kind, creationDirectory.relativePath, creationDirectory.path);
    },
    [beginCreating, creationDirectory]
  );

  /** 右键菜单入口：落点是被右键的那个目录，由 `App` 传下来。 */
  useEffect(() => {
    if (!createRequest) return;

    const directory = findTreeNode(tree, createRequest.parentRelativePath);
    const parentPath = directory?.path ?? rootPath;
    beginCreating(
      createRequest.kind,
      directory?.path ? createRequest.parentRelativePath : null,
      parentPath
    );
    onCreateRequestHandled?.();
  }, [createRequest, tree, rootPath, beginCreating, onCreateRequestHandled]);

  /** 新建行的同级节点 —— 重名预检要拿它比。 */
  const siblingsOf = useCallback(
    (parentRelativePath: string | null): readonly FileTreeNode[] => {
      if (parentRelativePath === null) return tree;
      return findTreeNode(tree, parentRelativePath)?.children ?? tree;
    },
    [tree]
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefresh();
      applyLists(await readLists());
      setPhase('ready');
      setErrorMessage(null);
      onIndexedRef.current?.();
    } catch (err) {
      // 不用 `setErrorMessage`：那个只在 `phase === 'error'` 时渲染（整块打不开那一屏），
      // 而刷新失败时侧栏是好的，设了也没人看得见。
      window.alert(
        t('workspace.refreshFailed', { detail: err instanceof Error ? err.message : String(err) })
      );
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, readLists, applyLists, t]);

  const canDelete = selected !== null && selected.type === 'file';
  const deleteHint =
    selected !== null && selected.type === 'directory'
      ? t('workspace.toolbar.deleteDirectoryHint')
      : t('workspace.toolbar.deleteNeedsSelection');

  /**
   * 新建行的重名预检。
   *
   * 没写扩展名时按 `.md` 算 —— 主进程会补它，所以不补的话「已有 `周报.md`、
   * 用户敲 `周报`」会漏报。这个规则与主进程的 `normalizeNewFileName` 是**同一条**，
   * 但这里只是**提示**：真正的判据是主进程的排他创建，预检让常见情况不必等一次
   * IPC 往返。两份规则漂了也不会出错，只会让提示偶尔失灵。
   */
  const isNameConflict = useCallback(
    (parentRelativePath: string | null, name: string) => {
      const dot = name.lastIndexOf('.');
      const finalName = dot > 0 ? name : `${name}.md`;
      const target = finalName.toLowerCase();
      return siblingsOf(parentRelativePath).some(
        (sibling) => sibling.name.toLowerCase() === target
      );
    },
    [siblingsOf]
  );

  /** 递归渲染树。缩进用 depth 算，不做嵌套 DOM —— 嵌套会让长文件名的省略号算错宽度。 */
  const renderNodes = (
    nodes: readonly FileTreeNode[],
    depth: number,
    parentRelativePath: string | null
  ): React.ReactNode => (
    <ul className="nexus-tree-list">
      {creating !== null && creating.parentRelativePath === parentRelativePath && (
        <li>
          <div className="nexus-tree-new-row" style={{ paddingLeft: 8 + depth * 12 + 14 }}>
            <NewEntryInput
              initialName={
                creating.kind === 'file'
                  ? `${t('workspace.untitledName')}.md`
                  : t('workspace.newFolderName')
              }
              placeholder={
                creating.kind === 'file'
                  ? `${t('workspace.untitledName')}.md`
                  : t('workspace.newFolderName')
              }
              selectBeforeExtension={creating.kind === 'file'}
              isConflict={(name) => isNameConflict(creating.parentRelativePath, name)}
              conflictLabel={(name) => t('workspace.nameExists', { name })}
              hint={t('workspace.createHint')}
              onCommit={(name) => {
                const run = creating.kind === 'file' ? onCreateFile : onCreateFolder;
                void run(creating.parentPath, name).then((createdPath) => {
                  // 失败时留着输入行：用户刚敲的名字还在，改一下就能重试
                  if (createdPath === null) return;
                  // 建好的东西还没进树（列表要重读一次），先记着，等它出现再选中。
                  pendingSelectRef.current = createdPath;
                  setCreating(null);
                });
              }}
              onCancel={() => setCreating(null)}
            />
          </div>
        </li>
      )}

      {nodes.map((node) => {
        if (node.type === 'directory') {
          const isOpen = expanded.has(node.relativePath);
          const isSelected = selected?.relativePath === node.relativePath;
          return (
            <li key={`d:${node.relativePath}`}>
              <button
                type="button"
                className={`nexus-tree-item nexus-tree-dir${
                  isSelected ? ' nexus-tree-item-selected' : ''
                }`}
                style={{ paddingLeft: 8 + depth * 12 }}
                data-tree-kind="directory"
                data-relative-path={node.relativePath}
                data-path={node.path ?? ''}
                data-selected={isSelected ? 'true' : undefined}
                aria-expanded={isOpen}
                onClick={() => {
                  setSelected(node);
                  toggleDirectory(node.relativePath);
                }}
                onContextMenu={(event) => {
                  if (!onNodeContextMenu) return;
                  event.preventDefault();
                  setSelected(node);
                  onNodeContextMenu(node, event.clientX, event.clientY);
                }}
              >
                <span
                  className={`nexus-tree-chevron${isOpen ? ' nexus-tree-chevron-open' : ''}`}
                  aria-hidden="true"
                >
                  {ChevronIcon}
                </span>
                <span className="nexus-tree-row-icon" aria-hidden="true">
                  {FolderRowIcon}
                </span>
                <span className="nexus-tree-name">{node.name}</span>
              </button>
              {isOpen && renderNodes(node.children, depth + 1, node.relativePath)}
            </li>
          );
        }

        const isActive = node.path !== null && node.path === activeFilePath;
        const isSelected = selected?.relativePath === node.relativePath;
        const attachment = isAttachmentNode(node);

        // 提取状态只有 `empty` / `failed` 会说话（`'none'` 同时表示「没有处理器」与
        // 「这一轮没被引用」，两者都不该提示）。判据在 `extractionNoteOf`，有单测。
        const extractionNote = node.document ? extractionNoteOf(node.document) : null;
        const tooltipLines = [node.path ?? node.relativePath];
        if (node.document) {
          const modifiedAt = formatTimestamp(node.document.modifiedAtMs);
          if (modifiedAt) tooltipLines.push(modifiedAt);
          if (extractionNote !== null) tooltipLines.push(t(`workspace.extraction.${extractionNote}`));
        }

        // 改名中：这一行换成输入框。缩进照旧，否则输入框会「跳」到别的位置去。
        if (node.path !== null && node.path === renamingPath) {
          return (
            <li key={`f:${node.relativePath}`}>
              <div className="nexus-tree-rename" style={{ paddingLeft: 8 + depth * 12 + 14 }}>
                <InlineRename
                  initialName={node.name}
                  onCommit={(newName) => onRenameCommit?.(node.path!, newName)}
                  onCancel={() => onRenameCancel?.()}
                />
              </div>
            </li>
          );
        }

        return (
          <li key={`f:${node.relativePath}`}>
            <button
              type="button"
              className={`nexus-tree-item nexus-tree-file${
                isActive ? ' nexus-tree-item-active' : ''
              }${isSelected ? ' nexus-tree-item-selected' : ''}`}
              // 文件比同级目录多缩进一档，让它们看起来「装在」目录里
              style={{ paddingLeft: 8 + depth * 12 + 14 }}
              data-tree-kind="file"
              data-relative-path={node.relativePath}
              data-path={node.path ?? ''}
              data-attachment={attachment ? 'true' : 'false'}
              data-selected={isSelected ? 'true' : undefined}
              title={tooltipLines.join('\n')}
              onClick={() => {
                setSelected(node);
                if (node.path) onOpenFile(node.path);
              }}
              onContextMenu={(event) => {
                // 没接 `onNodeContextMenu` 时让浏览器出原生菜单：这个组件在别的用例里
                // 也单独挂过，硬吞掉右键会让「右键没反应」变得无法解释。
                if (!onNodeContextMenu) return;
                event.preventDefault();
                setSelected(node);
                onNodeContextMenu(node, event.clientX, event.clientY);
              }}
            >
              <span className="nexus-tree-row-icon" aria-hidden="true">
                {attachment ? AttachmentRowIcon : NoteRowIcon}
              </span>
              <span className="nexus-tree-name">{node.name}</span>
              {/* 大小与提取状态只给附件看：笔记行上放一个「2.1 KB」是纯噪声，
                  而附件的体积正是「要不要把它挪走」的唯一线索。 */}
              {attachment && node.document && (
                <>
                  {extractionNote !== null && (
                    <span
                      className={`nexus-attachment-note nexus-attachment-note-${extractionNote}`}
                    >
                      {t(`workspace.extraction.${extractionNote}Short`)}
                    </span>
                  )}
                  <span className="nexus-attachment-size">
                    {formatFileSize(node.document.sizeBytes)}
                  </span>
                </>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const rootName = rootPath.replace(/^.*[\\/]/, '') || rootPath;
  const isEmptyWorkspace = tree.length === 0;
  const isFilteredToEmpty = !isEmptyWorkspace && visibleTree.length === 0;

  return (
    <aside className="nexus-workspace-sidebar" data-phase={phase} aria-label={t('workspace.title')}>
      <div className="nexus-sidebar-header" title={rootPath}>
        <span className="nexus-sidebar-root">{rootName}</span>
        {phase === 'ready' && (
          <span className="nexus-sidebar-count">
            {t('workspace.fileCount', { count: String(documents.length) })}
          </span>
        )}
      </div>

      <WorkspaceToolbar
        hasImages={imageCount > 0}
        showImages={showImages}
        onToggleImages={() => onShowImagesChange(!showImages)}
        hasDirectories={directoryPaths.length > 0}
        allExpanded={allExpanded}
        onToggleExpandAll={toggleExpandAll}
        canDelete={canDelete}
        deleteHint={deleteHint}
        onCreateFile={() => startCreating('file')}
        onCreateFolder={() => startCreating('folder')}
        onDelete={() => {
          if (selected?.path) onDeleteFile(selected.path);
        }}
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
      />

      {phase === 'indexing' && <p className="nexus-sidebar-note">{t('workspace.indexing')}</p>}

      {phase === 'error' && (
        <div className="nexus-sidebar-note nexus-sidebar-error" role="alert">
          <p>
            {t('workspace.indexFailed')}
            {errorMessage ? `：${errorMessage}` : ''}
          </p>
          <button
            type="button"
            className="nexus-sidebar-action"
            data-action="retry"
            onClick={() => void handleRefresh()}
          >
            {RetryIcon}
            <span>{t('workspace.retry')}</span>
          </button>
        </div>
      )}

      {/* 空态分两种，含义完全不同：工作区真的什么都没有，与「图片都被藏起来了」。
          后者要给一条出路 —— 否则用户面对一棵空树，只会以为文件丢了。 */}
      {phase === 'ready' && isEmptyWorkspace && (
        <div className="nexus-sidebar-note nexus-sidebar-empty">
          <p>{t('workspace.emptyCreate')}</p>
          <button
            type="button"
            className="nexus-sidebar-action"
            data-action="empty-create"
            onClick={() => startCreating('file')}
          >
            {t('workspace.toolbar.newFile')}
          </button>
        </div>
      )}

      {phase === 'ready' && isFilteredToEmpty && (
        <div className="nexus-sidebar-note nexus-sidebar-empty">
          <p>{t('workspace.filteredToZero')}</p>
          <button
            type="button"
            className="nexus-sidebar-action"
            data-action="show-all"
            onClick={() => onShowImagesChange(true)}
          >
            {t('workspace.showAll')}
          </button>
        </div>
      )}

      {phase === 'ready' && !isEmptyWorkspace && !isFilteredToEmpty && (
        <div className="nexus-tree-scroll">{renderNodes(visibleTree, 0, null)}</div>
      )}
    </aside>
  );
};
