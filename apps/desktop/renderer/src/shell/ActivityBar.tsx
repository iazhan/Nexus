import React from 'react';
import type { ActivityId } from './activity-bar-state.js';
import { useLocale } from '../hooks.js';
import { railIcon, type RailIconName } from '../components/rail-icons.js';

export interface ActivityBarProps {
  activeId: ActivityId;
  panelOpen: boolean;
  onSelect: (id: ActivityId) => void;
  onOpenSettings: () => void;
}

/**
 * 活动栏图标统一 20×20，图形来自 `components/rail-icons.tsx` —— 预览外壳用同一份图形，
 * 只是包成 18×18。**不要在这里另画一份**：两处各写一遍必然漂移（已经漂过一次）。
 */
const icon = (name: RailIconName): React.ReactNode => railIcon(name, 20);

const ACTIVITY_ITEMS: ReadonlyArray<{ id: ActivityId; labelKey: string; icon: React.ReactNode }> = [
  { id: 'workspace', labelKey: 'activity.workspace', icon: icon('workspace') },
  { id: 'outline', labelKey: 'activity.outline', icon: icon('outline') },
  { id: 'search', labelKey: 'activity.search', icon: icon('search') },
  { id: 'tags', labelKey: 'activity.tags', icon: icon('tags') },
  { id: 'graph', labelKey: 'activity.graph', icon: icon('graph') },
  { id: 'history', labelKey: 'activity.history', icon: icon('history') },
  { id: 'extensions', labelKey: 'activity.extensions', icon: icon('extensions') }
];

/**
 * 最左侧的活动栏：一列图标，点开右侧面板。
 *
 * **高亮只看 `activeId`，不看 `panelOpen`** —— 面板收起后图标仍然亮着，
 * 表示「上次看的是这个」。这是 VSCode 的行为，也是 `activeId` 不随收起重置的原因。
 *
 * 设置图标单独放在底部（`margin-top: auto`）：它是应用级入口，与上面四个
 * 文档级入口不属于同一组。
 */
export const ActivityBar: React.FC<ActivityBarProps> = ({
  activeId,
  panelOpen,
  onSelect,
  onOpenSettings
}) => {
  const { t } = useLocale();

  return (
    <nav className="nexus-activity-bar" aria-label={t('activity.aria')}>
      {ACTIVITY_ITEMS.map((item) => {
        const isActive = activeId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`nexus-activity-icon${isActive ? ' nexus-activity-icon-active' : ''}`}
            aria-label={t(item.labelKey)}
            aria-pressed={isActive && panelOpen}
            title={t(item.labelKey)}
            data-activity={item.id}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
          </button>
        );
      })}

      <button
        type="button"
        className="nexus-activity-icon nexus-activity-icon-bottom"
        aria-label={t('activity.settings')}
        title={t('activity.settings')}
        data-activity="settings"
        onClick={onOpenSettings}
      >
        {icon('settings')}
      </button>
    </nav>
  );
};
