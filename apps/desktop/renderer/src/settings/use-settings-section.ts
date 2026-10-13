/**
 * 设置窗口停在哪个分组。**只活在这一次窗口生命周期里** —— 打开设置不记录「上次停在哪」，
 * 期待的落点就是默认分组（或查询串指定的那一组）。
 *
 * **可以从查询串指定落点**（`?section=plugins`）：活动栏的插件面板跳过来时要直接落在
 * 插件页，而不是默认分组。查询串与 `window` 角色同一条路 —— 首帧就同步可读，
 * 不会先画一帧默认分组再跳。
 *
 * 这里不再管「视图切没切」：设置是独立窗口，「打开 / 关闭设置」是窗口的事，
 * 渲染进程里没有一个「当前是工作区还是设置页」的状态可管。
 */

import { useCallback, useState } from 'react';
import { SETTINGS_SECTION_PARAM } from '../../../ipc/channels.js';
import { DEFAULT_SECTION_ID, isSectionId, type SectionId } from './registry.js';

export interface SettingsSectionState {
  section: SectionId;
  selectSection(section: SectionId): void;
}

/**
 * 查询串里请求的分组。**认不出的值返回 `null`**（回落默认分组）—— 与 `readWindowRole()`
 * 的「认不出的值一律当主窗口」同一个方向：宁可停在默认分组，也不要把用户丢进一个空页。
 * 只在首次渲染读一次：窗口带查询串打开，落点就在首帧定好。
 */
function readRequestedSection(search: string): SectionId | null {
  const value = new URLSearchParams(search).get(SETTINGS_SECTION_PARAM);
  return value !== null && isSectionId(value) ? value : null;
}

export function useSettingsSection(): SettingsSectionState {
  const [section, setSection] = useState<SectionId>(
    () => readRequestedSection(window.location.search) ?? DEFAULT_SECTION_ID
  );

  const selectSection = useCallback((next: SectionId) => setSection(next), []);

  return { section, selectSection };
}
