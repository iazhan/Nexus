import React from 'react';
import type { ActivityId } from './activity-bar-state.js';
import { useLocale } from '../hooks.js';
import { railIcon, type RailIconName } from '../components/rail-icons.js';
import { DarkIcon, LightIcon } from '../components/theme-icons.js';

export interface ActivityBarProps {
  activeId: ActivityId;
  panelOpen: boolean;
  onSelect: (id: ActivityId) => void;
  onOpenSettings: () => void;
  /**
   * 当前**渲染出来的**明暗（`resolvedTheme.type`），不是用户的选择 —— 选择是
   * `<预设>@<模式>` 的复合量，画不出图标。
   */
  themeType: 'light' | 'dark';
  /** 用户主题与单变体预设没有另一边可切。`false` 时**禁用**而不是隐藏。 */
  themeSwitchable: boolean;
  onToggleTheme(): void;
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
 * ## 底部那一组：应用级入口
 *
 * 主题与设置压到底部（`margin-top: auto` 在容器上）：它们是**应用级**偏好，
 * 与上面那七个「文档级入口」（打开哪一屏）不属于同一组。
 *
 * 主题切换原先在标题栏右侧。挪过来是因为标题栏那一格是**窗口级**的（文件名、窗口按钮），
 * 而主题和设置一样是应用级偏好 —— 放在一起才有理由。**代价是轻量模式（单文件）没有活动栏，
 * 也就没有这枚按钮**：那里走菜单栏「首选项」里的模式三项（浅色 / 跟随系统 / 深色，
 * 由 `appearance.themeMode` 投影）与命令面板的 `toggle-theme` —— 少的是捷径，不是能力。
 *
 * 它**不共用 `nexus-activity-icon` 类名**：那个类名是「活动面板入口」的标记，
 * 有用例按它列出全部入口（`apps/desktop/test/activity-bar.test.ts`），主题不是其中之一。
 * 两者靠 CSS 里的选择器列表共享视觉规则，不靠共用类名。
 */
export const ActivityBar: React.FC<ActivityBarProps> = ({
  activeId,
  panelOpen,
  onSelect,
  onOpenSettings,
  themeType,
  themeSwitchable,
  onToggleTheme
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

      <div className="nexus-activity-bottom">
        {/* 图标画的是「按下去会到哪儿」：现在浅色就画月亮。 */}
        <button
          type="button"
          className="nexus-activity-theme"
          data-action="toggle-theme"
          aria-label={t('cmd.toggleTheme')}
          title={t('cmd.toggleTheme')}
          disabled={!themeSwitchable}
          onClick={onToggleTheme}
        >
          {themeType === 'light' ? DarkIcon : LightIcon}
        </button>

        <button
          type="button"
          className="nexus-activity-icon"
          aria-label={t('activity.settings')}
          title={t('activity.settings')}
          data-activity="settings"
          onClick={onOpenSettings}
        >
          {icon('settings')}
        </button>
      </div>
    </nav>
  );
};
