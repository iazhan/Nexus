import type { LinkBuildFailure } from '@nexus/core';

/**
 * 「写不出来」的三种原因 → 文案键。
 *
 * 每个原因一条独立的话，不是一句「复制失败」打天下：三种原因用户能采取的行动完全不同 ——
 * 没打开文档要**去打开**、跨卷是**没救**、名字里有怪字符是**换个格式**。
 * 一句笼统的失败提示会让三种情形都变成「那我该怎么办」。
 *
 * 这个映射放在渲染进程而不是 `@nexus/core` 里：core 只管**为什么写不出来**（`LinkBuildFailure`），
 * 「该对用户说什么」是界面的事 —— 与 core 里不带任何 `t()` 是同一条分层纪律。
 */
const FAILURE_KEYS: Readonly<Record<LinkBuildFailure, string>> = Object.freeze({
  'no-current-document': 'workspace.copyLinkNoDocument',
  'not-in-workspace': 'workspace.copyLinkNotInWorkspace',
  'unescapable-name': 'workspace.copyLinkUnescapable'
});

export function copyLinkFailureKey(reason: LinkBuildFailure): string {
  return FAILURE_KEYS[reason];
}
