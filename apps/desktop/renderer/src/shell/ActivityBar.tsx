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
 * ## 高亮 = 选中 **且** 面板开着
 *
 * 收起面板（再点一次当前图标）时高亮一起消失 —— 高亮表达的是「现在看的这一屏就是它」，
 * 面板收起来之后这句话就不成立了。
 *
 * **它与 `aria-pressed` 必须是同一个判据。** 早先这两处各写了一遍：类名只看 `activeId`，
 * 而 `aria-pressed` 是 `isActive && panelOpen` —— 于是收起之后视觉上还亮着、屏幕阅读器
 * 却读到「未按下」。那种不一致没人看得见，也没人测得到（2026-10-02 修的）。
 * 现在两者都由 `highlighted` 一个变量派生。
 *
 * `activeId` 本身**不随收起重置** —— 它决定「下次展开时显示哪一屏」，
 * 与「现在有没有高亮」是两件事。见 `activity-bar-state.ts` 的头注释。
 *
 * 设置图标单独放在底部（`margin-top: auto`）：它是应用级入口，与上面那些
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
        const highlighted = activeId === item.id && panelOpen;
        return (
          <button
            key={item.id}
            type="button"
            className={`nexus-activity-icon${highlighted ? ' nexus-activity-icon-active' : ''}`}
            aria-label={t(item.labelKey)}
            aria-pressed={highlighted}
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
