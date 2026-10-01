import type { RenameFileSkip, RenameSkipReason } from '../../../ipc/channels.js';
import { hasUnsavedChanges, type WorkspaceDocument } from './store.js';

/**
 * 有未保存修改的文档路径，交给主进程跳过回写（`RenameFileRequest.skipPaths`）。
 *
 * 回写它们等于跟用户的缓冲区打架：主进程改完盘，用户一保存就把回写覆盖回去 ——
 * 那次回写白做，而且用户看不到任何异常。
 *
 * 注意**只影响「写」，不影响「算」**：主进程照样读它们、照样算进计划里
 * （`index.ts` 的 rename handler），这样「N 篇文档有未保存的修改」这条回执才是准的。
 */
export function unsavedPaths(
  documents: readonly Pick<WorkspaceDocument, 'filePath' | 'saveState'>[]
): string[] {
  const paths: string[] = [];
  for (const document of documents) {
    if (document.filePath === null) continue;
    if (!hasUnsavedChanges(document)) continue;
    paths.push(document.filePath);
  }
  return paths;
}

/** 展示顺序。定死的，不跟着 `skipped` 的到达顺序走 —— 同一件事每次报告都该长一样。 */
const SKIP_REASONS: readonly RenameSkipReason[] = ['dirty', 'changed', 'unresolved', 'failed'];

const SKIP_MESSAGE_KEYS: Record<RenameSkipReason, string> = {
  dirty: 'workspace.renameSkipDirty',
  changed: 'workspace.renameSkipChanged',
  unresolved: 'workspace.renameSkipUnresolved',
  failed: 'workspace.renameSkipFailed'
};

/**
 * 跳过项归并成「每类一行」的回执。
 *
 * 归并而不是逐条列：同一篇文档里的三处引用写不出来，列三行只会把真正重要的
 * 「有几类问题」淹掉。四种原因各一条。
 *
 * `count` 就是 `skipped` 里该原因的**条数**，而每种原因的一条代表什么由主进程决定
 * （`electron/index.ts`）：`dirty` / `changed` / `failed` 是**每篇一条**（文案说「N 篇」），
 * `unresolved` 是**每处引用一条**（文案说「N 处」）。两边的单位必须对得上 ——
 * 改文案时先看那一侧是怎么 push 的。
 */
export function describeSkips(
  skipped: readonly RenameFileSkip[],
  t: (key: string, vars?: Record<string, string>) => string
): string[] {
  const counts = new Map<RenameSkipReason, number>();
  for (const item of skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }

  const lines: string[] = [];
  for (const reason of SKIP_REASONS) {
    const count = counts.get(reason);
    if (count === undefined || count === 0) continue;
    lines.push(t(SKIP_MESSAGE_KEYS[reason], { count: String(count) }));
  }
  return lines;
}
