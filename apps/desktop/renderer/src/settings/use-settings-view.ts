/**
 * 设置视图的会话状态：当前在工作区还是设置页、设置页停在哪个分组。
 *
 * 分组持久化在 `settings.lastSection`（蓝图 §3.3 的「可恢复状态」）；**视图本身不持久化** ——
 * 每次启动都落在工作区，否则「上次关在设置页」会让应用打开时看不到文件。
 */

import { useCallback, useState } from 'react';
import { useSetting } from '../hooks.js';
import { DEFAULT_SECTION_ID, isSectionId, type SectionId } from './registry.js';

export interface SettingsViewState {
  view: 'workspace' | 'settings';
  section: SectionId;
  open(): void;
  close(): void;
  selectSection(section: SectionId): void;
}

export function useSettingsView(): SettingsViewState {
  const [view, setView] = useState<'workspace' | 'settings'>('workspace');
  const [storedSection, setStoredSection] = useSetting('settings.lastSection');

  // 存档里可能是旧的分组 id（分组改名 / 删掉）—— 校验后回落，否则左栏高亮会落在不存在的项上。
  const section: SectionId = isSectionId(storedSection) ? storedSection : DEFAULT_SECTION_ID;

  const open = useCallback(() => setView('settings'), []);
  const close = useCallback(() => setView('workspace'), []);
  const selectSection = useCallback(
    (next: SectionId) => setStoredSection(next),
    [setStoredSection]
  );

  return { view, section, open, close, selectSection };
}
