import React, { useCallback, useEffect } from 'react';
import { useLocale } from '../hooks.js';
import { WindowControls } from '../WindowControls.js';
import { UpdateView } from './UpdateView.js';

/**
 * 更新窗口的外壳：自绘标题栏 + 更新本体。
 *
 * 与设置窗口同构（共用 `.nexus-app-root` / `.nexus-header-bar` / `.nexus-body` 三层骨架），
 * 两件事由本组件负责、**不下沉到 `UpdateView`**：
 *
 * - **Escape 关窗**。挂在 window 上（不是某个面板上）。`defaultPrevented` 那道判断照抄设置
 *   窗口 —— 它今天还不起作用（更新视图里没有弹层），但少了它，将来往日志里加一个弹层时
 *   就会顺带把整个窗口关掉。
 * - **标题栏双击最大化**。与其它窗口同一行为，跳过按钮与下拉菜单。
 */
export const UpdateWindow: React.FC = () => {
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
    <div className="nexus-app-root" data-window-role="update">
      <header className="nexus-header-bar" onDoubleClick={handleHeaderDoubleClick}>
        <div className="nexus-header-left">
          <span className="nexus-app-title">{t('update.title')}</span>
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
        <UpdateView />
      </div>
    </div>
  );
};
