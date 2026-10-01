import React, { useMemo } from 'react';
import type { RenameFileChange, RenameFileSkip } from '../../../ipc/channels.js';
import { Dialog } from '../components/Dialog.js';
import { useLocale } from '../hooks.js';
import { diffLines } from './line-diff.js';
import { describeSkips } from './rename.js';

export interface RenamePreviewProps {
  /** 改名前的文件名（只用于「旧 → 新」那一行）。 */
  fromName: string;
  /** 改名后的文件名。 */
  toName: string;
  /** 计划里要改写的每一篇。至少一篇 —— 零改动不弹这一屏（见 `App.tsx`）。 */
  changes: readonly RenameFileChange[];
  /** 计划里明确不改的那些（`dirty` / `unresolved`）。如实列出来。 */
  skipped: readonly RenameFileSkip[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 改名前的确认屏：把「要改写哪些文档、改成什么样」摆在明面上（提案 §8 D5）。
 *
 * ## 为什么只画改动行，不画整篇 diff
 *
 * 回写只碰含引用的那几行，而一篇笔记动辄几百行 —— 把 `same` 行全画出来，
 * 真正要看的那一行会被埋掉，用户滚半天还是不知道改了什么。
 * `diffLines` 已经保证「删在上、加在下」的顺序，所以只留这两类仍然读得通。
 *
 * ## 为什么确认按钮不是默认焦点
 *
 * 这一屏点下去会**改别人的文件**（虽然是可回退的）。默认焦点给「取消」，
 * 想确认就多按一次 Tab —— 而且 Enter 在这里不该是「闭着眼睛继续」的那个键：
 * 打开这一屏的正是内联输入框里的那次 Enter，同一个键连着按两下不该直接落盘。
 */
export const RenamePreview: React.FC<RenamePreviewProps> = ({
  fromName,
  toName,
  changes,
  skipped,
  onConfirm,
  onCancel
}) => {
  const { t } = useLocale();

  // 每一篇的 diff 只算一次。`changes` 是 IPC 回来的新数组，所以依赖它本身就够。
  const rows = useMemo(
    () =>
      changes.map((change) => ({
        path: change.path,
        relativePath: change.relativePath,
        lines: diffLines(change.before, change.after).filter((line) => line.kind !== 'same')
      })),
    [changes]
  );

  const skipLines = useMemo(() => describeSkips(skipped, t), [skipped, t]);

  return (
    <Dialog
      open
      onClose={onCancel}
      label={t('workspace.renameDialogTitle')}
      panelClassName="nexus-rename-dialog"
      panelId="nexus-rename-preview"
    >
      <h3 className="nexus-rename-title">{t('workspace.renameDialogTitle')}</h3>

      {/* 「旧 → 新」不用文案键：箭头语言无关，而「把名字念一遍」这件事不该有两种说法 */}
      <p className="nexus-rename-target">
        <span className="nexus-rename-old">{fromName}</span>
        <span className="nexus-rename-arrow" aria-hidden="true">
          →
        </span>
        <span className="nexus-rename-new">{toName}</span>
      </p>

      <p className="nexus-rename-intro">{t('workspace.renameDialogIntro')}</p>
      <p className="nexus-rename-count">
        {t('workspace.renameDialogCount', { count: String(changes.length) })}
      </p>

      <ul className="nexus-rename-list" data-rename-changes="">
        {rows.map((row) => (
          <li key={row.path} className="nexus-rename-item" data-rename-path={row.relativePath}>
            <div className="nexus-rename-file">{row.relativePath}</div>
            <ul className="nexus-rename-diff">
              {row.lines.map((line, index) => (
                <li key={`${index}-${line.kind}`} className={`nexus-diff-${line.kind}`}>
                  <span className="nexus-diff-marker">{line.kind === 'added' ? '+' : '-'}</span>
                  <span className="nexus-diff-text">{line.text || ' '}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {/* 跳过项**在确认之前**就要说：用户可能正是为了那几篇才点进来的 */}
      {skipLines.length > 0 && (
        <ul className="nexus-rename-skips" data-rename-skips="">
          {skipLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <div className="nexus-rename-actions">
        <button type="button" className="nexus-rename-button" onClick={onCancel}>
          {t('workspace.renameCancel')}
        </button>
        <button
          type="button"
          className="nexus-rename-button nexus-rename-button-primary"
          data-rename-confirm=""
          onClick={onConfirm}
        >
          {t('workspace.renameApply')}
        </button>
      </div>
    </Dialog>
  );
};
