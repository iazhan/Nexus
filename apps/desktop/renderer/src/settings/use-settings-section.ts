/**
 * 设置窗口停在哪个分组。
 *
 * 分组持久化在 `settings.lastSection`（蓝图 §3.3 的「可恢复状态」）。
 *
 * **这里不再管「视图切没切」** —— 设置是独立窗口之后，「打开 / 关闭设置」是窗口的事
 * （主进程 `createSettingsWindow` / `closeSettingsWindow`），渲染进程里没有一个
 * 「当前是工作区还是设置页」的状态可管。留着它只会造出第二个真相源。
 *
 * **可以从查询串指定落点**（`?section=plugins`）：活动栏的插件面板跳过来时要直接落在
 * 插件页，而不是用户上次看的那一组。查询串与 `window` 角色同一条路 —— 首帧就同步可读，
 * 不会先画一帧旧分组再跳。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSetting } from '../hooks.js';
import { SETTINGS_SECTION_PARAM } from '../../../ipc/channels.js';
import { DEFAULT_SECTION_ID, isSectionId, type SectionId } from './registry.js';

export interface SettingsSectionState {
  section: SectionId;
  selectSection(section: SectionId): void;
}

/**
 * 查询串里请求的分组。**认不出的值返回 `null`**（回落存档）—— 与 `readWindowRole()`
 * 的「认不出的值一律当主窗口」同一个方向：宁可停在默认分组，也不要把用户丢进一个空页。
 */
function readRequestedSection(search: string): SectionId | null {
  const value = new URLSearchParams(search).get(SETTINGS_SECTION_PARAM);
  return value !== null && isSectionId(value) ? value : null;
}

export function useSettingsSection(): SettingsSectionState {
  const [storedSection, setStoredSection] = useSetting('settings.lastSection');

  /**
   * 「从别处跳进来时要落在哪一组」。**只在首帧消费一次**，随后写进存档、由存档驱动 ——
   * 留着它会让用户点别的分组点不动（URL 没变，它一直压着存档）。
   */
  const requestedRef = useRef<SectionId | null>(readRequestedSection(window.location.search));

  useEffect(() => {
    const requested = requestedRef.current;
    if (requested === null) return;
    requestedRef.current = null;
    // 写进存档而不是只放在内存里：用户确实看过这一组了，下次打开设置停在这里 ——
    // 与「在左栏点了一下」是同一种效果，两条路不留不同的状态。
    setStoredSection(requested);
  }, [setStoredSection]);

  // 存档里可能是旧的分组 id（分组改名 / 删掉）—— 校验后回落，否则左栏高亮会落在不存在的项上。
  const stored: SectionId = isSectionId(storedSection) ? storedSection : DEFAULT_SECTION_ID;
  // 首帧（effect 还没跑）用请求的分组；之后一律由存档驱动，单一真相源。
  const section: SectionId = requestedRef.current ?? stored;

  const selectSection = useCallback(
    (next: SectionId) => setStoredSection(next),
    [setStoredSection]
  );

  return { section, selectSection };
}
