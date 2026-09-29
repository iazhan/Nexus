import React, { useCallback, useEffect } from 'react';
import { useLocale } from '../hooks.js';
import { WindowControls } from '../WindowControls.js';
import { SettingsView } from './SettingsView.js';
import { useSettingsSection } from './use-settings-section.js';

/**
 * 设置窗口的外壳：自绘标题栏 + 设置本体。
 *
 * 与主窗口共用 `.nexus-app-root` / `.nexus-header-bar` / `.nexus-body` 三层骨架 ——
 * 设置窗口不是另一套界面，只是同一套骨架里换了中间的内容。
 *
 * 三件由本组件负责、**不下沉到 `SettingsView`** 的事：
 *
 * - **Escape 关窗**。挂在 window 上（主窗口那版挂在设置视图里，因为设置那时是个视图）。
 *   `defaultPrevented` 那道判断不能省：覆盖项清单是个 `Dialog`，它的 Escape 挂在面板上并
 *   已 `preventDefault` —— 少了这道判断，关弹层会顺带把整个窗口关掉。
 * - **标题栏双击最大化**。与主窗口同一行为，跳过按钮与下拉菜单。
 * - **窗口按钮的文案**。`WindowControls` 的 tooltip 按当前语言传进去，才跟得上语言切换。
 */
export const SettingsWindow: React.FC = () => {
  const { t } = useLocale();
  const { section, selectSection } = useSettingsSection();

  const closeWindow = useCallback(() => {
    window.nexus?.closeWindow?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeWindow();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeWindow]);

  const handleHeaderDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, .nexus-menu-dropdown')) return;
    window.nexus?.maximizeWindow?.();
  }, []);

  return (
    <div className="nexus-app-root" data-window-role="settings">
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">{t('settings.title')}</span>
        </div>

        {/* 中间留空但保留节点：`.nexus-header-bar` 靠 space-between 定位右侧按钮，
            少一个子元素会让左侧标题被拉满、窗口按钮贴不到右边缘。 */}
        <div className="nexus-header-center" />

        <div className="nexus-header-right">
          <WindowControls
            labels={{
              minimize: t('window.minimize'),
              maximize: t('window.maximize'),
              restore: t('window.restore'),
              close: t('window.close')
            }}
          />
        </div>
      </header>

      <div className="nexus-body">
        <SettingsView section={section} onSelectSection={selectSection} />
      </div>
    </div>
  );
};
