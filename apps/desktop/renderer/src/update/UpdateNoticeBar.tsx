import React, { useCallback } from 'react';
import { useLocale } from '../hooks.js';
import { useUpdateNotice } from './use-update-state.js';

/**
 * 主窗口的更新提示条。**非模态** —— 不打断任何事，用户点了才打开更新窗口。
 *
 * ## 三条判据
 *
 * 1. **只有真该提示时才画。** 阶段必须是有更新的那三个之一，且这一版没被跳过、
 *    也不在「稍后提醒」的期限内。
 * 2. **「跳过」判的是版本相等，不是「跳过字段非空」。** 用户跳过的是 0.74.0，
 *    而 0.75.0 出来了照样要提示 —— 他表达的是「那一版我不要」。
 * 3. **稍后的判据是现算的**（`Date.now() < remindAfter`），不是某个布尔标记 ——
 *    到期自动恢复，不需要任何定时器。
 *
 * ## 为什么不用 `useUpdateState`
 *
 * 见 `use-update-state.ts`：下载进度每秒变好几次，全量订阅会让整个主窗口跟着重渲染。
 * 这里只关心「要不要显示、显示哪一句」。
 */
export const UpdateNoticeBar: React.FC = () => {
  const { t } = useLocale();
  const state = useUpdateNotice();

  const onOpen = useCallback(() => {
    void window.nexus?.openUpdateWindow?.();
  }, []);

  if (!state) return null;
  if (state.phase !== 'available' && state.phase !== 'downloading' && state.phase !== 'downloaded') {
    return null;
  }
  if (state.latest !== null && state.skipped === state.latest) return null;
  if (state.remindAfter !== null && Date.now() < state.remindAfter) return null;

  const ready = state.phase === 'downloaded';
  const text = ready
    ? t('update.noticeBarReady')
    : t('update.noticeBar', { version: state.latest ?? '' });

  return (
    // `role="status"`：提示条是**自己冒出来的**，用户可能没在看屏幕 —— 读屏该播一句。
    // 文案只在阶段真的变了的时候才变（进度变化不改这两个键），所以不会反复播报。
    <div className="nexus-update-notice" data-update-notice="" role="status">
      <span className="nexus-update-notice-text">{text}</span>
      <button type="button" className="nexus-update-notice-action" onClick={onOpen}>
        {t('update.noticeAction')}
      </button>
    </div>
  );
};
