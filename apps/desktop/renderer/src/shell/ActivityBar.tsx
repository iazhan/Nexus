import React from 'react';
import type { ActivityId } from './activity-bar-state.js';
import { useLocale } from '../hooks.js';

export interface ActivityBarProps {
  activeId: ActivityId;
  panelOpen: boolean;
  onSelect: (id: ActivityId) => void;
  onOpenSettings: () => void;
}

/** 图标统一 20×20、`currentColor`，颜色交给 CSS 控制。 */
const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

const WorkspaceIcon = (
  <svg {...ICON_PROPS}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const OutlineIcon = (
  <svg {...ICON_PROPS}>
    <line x1="9" y1="6" x2="21" y2="6" />
    <line x1="9" y1="12" x2="21" y2="12" />
    <line x1="9" y1="18" x2="15" y2="18" />
    <line x1="4" y1="6" x2="4" y2="6" />
    <line x1="4" y1="12" x2="4" y2="12" />
    <line x1="4" y1="18" x2="4" y2="18" />
  </svg>
);

const SearchIcon = (
  <svg {...ICON_PROPS}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const TagsIcon = (
  <svg {...ICON_PROPS}>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6z" />
    <circle cx="8" cy="8" r="1.4" />
  </svg>
);

const GraphIcon = (
  <svg {...ICON_PROPS}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <circle cx="11" cy="18" r="2.4" />
    <path d="M8.1 7 15.9 7.7M7.2 8.2l2.7 7.6M16.6 10.2l-4.1 5.6" />
  </svg>
);

const HistoryIcon = (
  <svg {...ICON_PROPS}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4.5V9h4.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

const ExtensionsIcon = (
  <svg {...ICON_PROPS}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const SettingsIcon = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" />
  </svg>
);

const ACTIVITY_ITEMS: ReadonlyArray<{ id: ActivityId; labelKey: string; icon: React.ReactNode }> = [
  { id: 'workspace', labelKey: 'activity.workspace', icon: WorkspaceIcon },
  { id: 'outline', labelKey: 'activity.outline', icon: OutlineIcon },
  { id: 'search', labelKey: 'activity.search', icon: SearchIcon },
  { id: 'tags', labelKey: 'activity.tags', icon: TagsIcon },
  { id: 'graph', labelKey: 'activity.graph', icon: GraphIcon },
  { id: 'history', labelKey: 'activity.history', icon: HistoryIcon },
  { id: 'extensions', labelKey: 'activity.extensions', icon: ExtensionsIcon }
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
        {SettingsIcon}
      </button>
    </nav>
  );
};
