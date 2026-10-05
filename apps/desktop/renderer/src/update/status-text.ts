/**
 * 更新阶段 → 一句人话 + 一个色调。**更新窗口与设置页的「关于」都读这一份** ——
 * 两处各写一遍 switch 必然漂移，而漂移的表现是「同一个状态在两个窗口里说法不同」，
 * 只有同时打开两个窗口才看得出来。
 *
 * `null`（还没取到状态）与 `unsupported`（这个构建没有更新通道）是两件事：
 * 前者是「还不知道」，后者是「知道，而且它永远不会有」。合并成一句会让开发模式下的
 * 用户以为应用卡住了。
 */

import type { UpdateState } from '../../../ipc/channels.js';

type Translate = (key: string, vars?: Record<string, string>) => string;

/** 状态点 / 状态文字的色调。落到 CSS 上是 `[data-tone]` 属性选择器。 */
export type UpdateTone = 'accent' | 'success' | 'muted' | 'error';

export function updateStatusTone(state: UpdateState | null): UpdateTone {
  switch (state?.phase ?? 'idle') {
    // 「有东西可做」统一走强调色：`available` 与 `downloaded` 的下一步动作不同，
    // 但它们在「这不是常态」这件事上是一类。
    case 'available':
    case 'downloading':
    case 'downloaded':
      return 'accent';
    case 'up-to-date':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'muted';
  }
}

export function updateProgressPercent(state: UpdateState | null): number {
  return Math.round((state?.progress ?? 0) * 100);
}

export function updateStatusText(state: UpdateState | null, t: Translate): string {
  const phase = state?.phase ?? 'idle';

  switch (phase) {
    case 'unsupported':
      return t('update.unsupported');
    case 'checking':
      return t('update.checking');
    case 'up-to-date':
      return t('update.upToDate');
    case 'available':
      return t('update.available', { version: state?.latest ?? '' });
    case 'downloading':
      return t('update.downloading', { percent: String(updateProgressPercent(state)) });
    case 'downloaded':
      return t('update.downloaded');
    case 'error':
      return t('update.failed');
    default:
      return t('update.idle');
  }
}
