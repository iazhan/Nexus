import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsWindow } from './settings/SettingsWindow';
import { ThemeWindow } from './settings/ThemeWindow';
import { readWindowRole, type WindowRole } from './window-role';
import './App.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

/**
 * 三个窗口跑同一份产物，只有这里分叉。角色来自 URL 查询串，**同步可读** ——
 * 等一次 IPC 再决定渲染什么，用户会先看到主界面闪一下（见 `window-role.ts`）。
 */
const role = readWindowRole(window.location.search);

const ROOT_BY_ROLE: Record<WindowRole, React.ReactNode> = {
  main: <App />,
  settings: <SettingsWindow />,
  theme: <ThemeWindow />
};

/** 白屏兜底卡片上的标题也得按角色换 —— 主题窗口白屏却报「Nexus failed to render」会让人找错地方。 */
const TITLE_KEY_BY_ROLE: Record<WindowRole, string> = {
  main: 'error.appTitle',
  settings: 'error.settingsTitle',
  theme: 'error.themeTitle'
};

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 最外层兜底：任何渲染期异常都降级成可见的错误卡片，而不是整窗白屏。 */}
    <ErrorBoundary titleKey={TITLE_KEY_BY_ROLE[role]}>{ROOT_BY_ROLE[role]}</ErrorBoundary>
  </React.StrictMode>
);
