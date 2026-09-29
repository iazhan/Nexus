import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsWindow } from './settings/SettingsWindow';
import { readWindowRole } from './window-role';
import './App.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

/**
 * 两个窗口跑同一份产物，只有这里分叉。角色来自 URL 查询串，**同步可读** ——
 * 等一次 IPC 再决定渲染什么，用户会先看到主界面闪一下（见 `window-role.ts`）。
 */
const role = readWindowRole(window.location.search);

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 最外层兜底：任何渲染期异常都降级成可见的错误卡片，而不是整窗白屏。
        两个窗口共用 ErrorBoundary，标题按角色换 —— 设置窗口白屏却报「Nexus failed to render」
        会让人以为主窗口出事了。 */}
    <ErrorBoundary titleKey={role === 'settings' ? 'error.settingsTitle' : 'error.appTitle'}>
      {role === 'settings' ? <SettingsWindow /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
