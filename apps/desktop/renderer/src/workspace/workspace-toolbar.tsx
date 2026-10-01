import React from 'react';
import { useLocale } from '../hooks.js';
import {
  CollapseAllIcon,
  ExpandAllIcon,
  ImagesHiddenIcon,
  ImagesVisibleIcon,
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
  TrashIcon
} from '../components/workspace-icons.js';

export interface WorkspaceToolbarProps {
  /**
   * 树里存在**图片**。
   *
   * 开关只在为真时渲染 —— 一个恒亮但没有作用的按钮会让人怀疑它坏了
   * （Markra 的 `assetVisibilityToggleAvailable` 是同一条判据）。
   *
   * 判的是图片而不是「附件」：这一栏的意图是「树被图淹了」，而 PDF / DOCX 通常是
   * 个位数、且往往正是要找的东西。见 `tree-filter.ts` 的头注释。
   */
  hasImages: boolean;
  showImages: boolean;
  onToggleImages(): void;
  /**
   * 树里存在目录 —— 没有目录时「全部展开」无事可做，所以那枚按钮不渲染。
   *
   * 与图片开关同一条判据：一个恒亮但没作用的按钮会让人怀疑它坏了。
   */
  hasDirectories: boolean;
  /** 所有目录都展开了。按钮据此决定自己是「展开」还是「收起」，也决定画哪枚图标。 */
  allExpanded: boolean;
  onToggleExpandAll(): void;
  /**
   * 删除能不能用。**必须与用户看得见的高亮一致** ——
   * 否则「删除」会让人以为删的是选中的那个，而实际删的是另一个，
   * 那是数据丢失级的不一致。
   */
  canDelete: boolean;
  /** 不能删时按钮的 `title`，说明**为什么**。灰按钮不带解释时用户只会反复点它。 */
  deleteHint: string;
  onCreateFile(): void;
  onCreateFolder(): void;
  onDelete(): void;
  onRefresh(): void;
  refreshing: boolean;
}

/**
 * 工作区工具栏：新建文件 · 新建文件夹 · 删除 · 显示图片 · 全部展开/收起 · 重新扫描。
 *
 * ## 五个动作都是平铺按钮，不做下拉
 *
 * Markra 把「新建文件 / 新建文件夹」收进一个「+」下拉，是因为它那一栏里还有
 * 排序、折叠全部、清理未用图片、打开文件夹 —— 七八个动作塞不下。Nexus 这一栏只有
 * 五个，把两个最常用的藏进菜单只会多一次点击。
 *
 * ## 开关藏的是**图片**，不是全部附件
 *
 * 意图是「树被图淹了」；PDF / DOCX 通常是找的目标，藏起来只会让人以为文件丢了。
 * Markra 的 `fileTreeAssetsVisible` 也是只判图片。
 *
 * ## 「全部展开 / 收起」抄的是 Markra 的 `toggleAllFolders`
 *
 * 它那枚按钮判的是 `folderExpansionAvailable`（树里有目录才渲染），
 * 展开/收起按「当前是不是全展开」二选一 —— 这里照做，但**状态由调用方算好传进来**：
 * 展开集合住在侧栏，工具栏不碰它（同「删除能不能用」那条判据）。
 *
 * ## 「重新扫描」是两个参考都没有的动作
 *
 * Markra 靠 file watcher 整树 refresh、OpenKnowledge 靠窗口 focus 自动刷新，
 * 两家都没有手动刷新按钮。Nexus 需要它：树来自**索引**，而索引只在「重建」时更新，
 * watcher 报的变更不会自动进索引。这是「索引 + 目录」两路数据源带来的必然代价。
 *
 * ## 这个组件是纯展示 + 回调
 *
 * 不读 store、不发 IPC、不持状态。所有动作与可用性都由调用方算好传进来 ——
 * 「删除该不该亮」这件事需要知道当前选中了什么，而选中状态住在侧栏里。
 */
export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({
  hasImages,
  showImages,
  onToggleImages,
  hasDirectories,
  allExpanded,
  onToggleExpandAll,
  canDelete,
  deleteHint,
  onCreateFile,
  onCreateFolder,
  onDelete,
  onRefresh,
  refreshing
}) => {
  const { t } = useLocale();

  return (
    <div className="nexus-workspace-toolbar" role="toolbar" aria-label={t('workspace.title')}>
      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="new-file"
        title={t('workspace.toolbar.newFile')}
        aria-label={t('workspace.toolbar.newFile')}
        onClick={onCreateFile}
      >
        {NewFileIcon}
      </button>

      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="new-folder"
        title={t('workspace.toolbar.newFolder')}
        aria-label={t('workspace.toolbar.newFolder')}
        onClick={onCreateFolder}
      >
        {NewFolderIcon}
      </button>

      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="delete"
        // 禁用时 `title` 换成原因，而不是把两个说法叠在一起 ——
        // 「删除。先选中一个文件」读起来像两个动作。
        title={canDelete ? t('workspace.toolbar.delete') : deleteHint}
        aria-label={t('workspace.toolbar.delete')}
        aria-disabled={!canDelete}
        disabled={!canDelete}
        onClick={onDelete}
      >
        {TrashIcon}
      </button>

      {hasImages && (
        <button
          type="button"
          className={`nexus-toolbar-button${showImages ? ' nexus-toolbar-button-on' : ''}`}
          data-action="toggle-images"
          data-shown={showImages ? 'true' : 'false'}
          title={showImages ? t('workspace.toolbar.hideImages') : t('workspace.toolbar.showImages')}
          aria-label={t('workspace.toolbar.showImages')}
          aria-pressed={showImages}
          onClick={onToggleImages}
        >
          {showImages ? ImagesVisibleIcon : ImagesHiddenIcon}
        </button>
      )}

      {hasDirectories && (
        <button
          type="button"
          className="nexus-toolbar-button"
          data-action="toggle-expand"
          data-expanded={allExpanded ? 'true' : 'false'}
          title={allExpanded ? t('workspace.toolbar.collapseAll') : t('workspace.toolbar.expandAll')}
          aria-label={
            allExpanded ? t('workspace.toolbar.collapseAll') : t('workspace.toolbar.expandAll')
          }
          onClick={onToggleExpandAll}
        >
          {allExpanded ? CollapseAllIcon : ExpandAllIcon}
        </button>
      )}

      <button
        type="button"
        className="nexus-toolbar-button"
        data-action="refresh"
        title={refreshing ? t('workspace.toolbar.refreshing') : t('workspace.toolbar.refresh')}
        aria-label={t('workspace.toolbar.refresh')}
        aria-busy={refreshing}
        disabled={refreshing}
        onClick={onRefresh}
      >
        {RefreshIcon}
      </button>
    </div>
  );
};
