import type { LinkBuildFailure } from '@nexus/core';

/**
 * 「写不出一条链接」的三种原因 → 文案键。**同一个原因，两个动作的话不一样。**
 *
 * ## 为什么按动作分两套，而不是一套通用的
 *
 * 三种原因里有两种的话可以通用（跨盘、名字里有怪字符），但 `no-current-document` 不能：
 *
 * - 复制链接时它意味着「你还没打开任何文档」—— 去打开一篇。
 * - 插入链接时**当前文档一定是开着的**（正在往里插），它意味着「这篇还没保存、没有路径」——
 *   去保存，或者把链接格式换成 WikiLink（那一档根本不需要当前文档的路径）。
 *
 * 一句话套两个场景，必然对其中一个说错下一步。所以按动作分叉，而不是把措辞磨到两边都含糊。
 *
 * ## 为什么这个映射在渲染进程而不在 `@nexus/core`
 *
 * core 只管**为什么写不出来**（`LinkBuildFailure`），「该对用户说什么」是界面的事 ——
 * 与 core 里不带任何 `t()` 是同一条分层纪律。
 */
export type LinkAction = 'copy' | 'insert';

const FAILURE_KEYS: Readonly<Record<LinkAction, Readonly<Record<LinkBuildFailure, string>>>> =
  Object.freeze({
    copy: Object.freeze({
      'no-current-document': 'workspace.copyLinkNoDocument',
      'not-in-workspace': 'workspace.copyLinkNotInWorkspace',
      'unescapable-name': 'workspace.copyLinkUnescapable'
    }),
    insert: Object.freeze({
      'no-current-document': 'editor.insertLinkNoDocument',
      'not-in-workspace': 'editor.insertLinkNotInWorkspace',
      'unescapable-name': 'editor.insertLinkUnescapable'
    })
  });

export function linkFailureKey(reason: LinkBuildFailure, action: LinkAction): string {
  return FAILURE_KEYS[action][reason];
}
