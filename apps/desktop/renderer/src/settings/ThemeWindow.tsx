import React, { useCallback, useEffect } from 'react';
import { useLocale } from '../hooks.js';
import { WindowControls } from '../WindowControls.js';
import { ThemeEditor } from './ThemeEditor.js';

/**
 * 主题窗口的外壳：自绘标题栏 + 主题编辑器。
 *
 * 与设置窗口同构 —— 共用 `.nexus-app-root` / `.nexus-header-bar` / `.nexus-body` 三层骨架，
 * 窗口不是另一套界面，只是同一套骨架里换了中间的内容。三件由本组件负责、不下沉到编辑器的事
 * 也与它一样：**Escape 关窗**（挂 window，`defaultPrevented` 那道判断不能省 —— 覆盖项清单是
 * 个 `Dialog`，它的 Escape 已 `preventDefault`，少了判断关弹层会顺带把整个窗口关掉）、
 * **标题栏双击最大化**、**窗口按钮文案按当前语言传进去**。
 *
 * 与设置窗口的唯一分叉：**本窗口没有工作区、也不开别的窗口**，所以它比设置窗口更薄 ——
 * 没有分组导航，编辑器就是全部内容。
 */
export const ThemeWindow: React.FC = () => {
  const { t } = useLocale();

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
    <div className="nexus-app-root" data-window-role="theme">
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">{t('theme.editor.title')}</span>
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

      <div className="nexus-body nexus-theme-window-body">
        <ThemeEditor />
      </div>
    </div>
  );
};
