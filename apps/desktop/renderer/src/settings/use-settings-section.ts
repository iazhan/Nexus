/**
 * 设置窗口停在哪个分组。
 *
 * 分组持久化在 `settings.lastSection`（蓝图 §3.3 的「可恢复状态」）。
 *
 * **这里不再管「视图切没切」** —— 设置是独立窗口之后，「打开 / 关闭设置」是窗口的事
 * （主进程 `createSettingsWindow` / `closeSettingsWindow`），渲染进程里没有一个
 * 「当前是工作区还是设置页」的状态可管。留着它只会造出第二个真相源。
 */

import { useCallback } from 'react';
import { useSetting } from '../hooks.js';
import { DEFAULT_SECTION_ID, isSectionId, type SectionId } from './registry.js';

export interface SettingsSectionState {
  section: SectionId;
  selectSection(section: SectionId): void;
}

export function useSettingsSection(): SettingsSectionState {
  const [storedSection, setStoredSection] = useSetting('settings.lastSection');

  // 存档里可能是旧的分组 id（分组改名 / 删掉）—— 校验后回落，否则左栏高亮会落在不存在的项上。
  const section: SectionId = isSectionId(storedSection) ? storedSection : DEFAULT_SECTION_ID;

  const selectSection = useCallback(
    (next: SectionId) => setStoredSection(next),
    [setStoredSection]
  );

  return { section, selectSection };
}
