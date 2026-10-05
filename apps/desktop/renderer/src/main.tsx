/**
 * 四个窗口共用的入口 —— 字体在这里 import 一次就覆盖全部角色（`ROOT_BY_ROLE` 是唯一的渲染分叉，
 * 放进任一角色的样式里，另外三个窗口就没有打包字体）。
 *
 * 两个包提供 `Inter Variable` / `JetBrains Mono Variable` 两个家族名，由 `App.css` 的 `:root` 引用。
 * **两者都不含中文字形**，中文靠那两条栈里的显式候选。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsWindow } from './settings/SettingsWindow';
import { ThemeWindow } from './settings/ThemeWindow';
import { UpdateWindow } from './update/UpdateWindow';
import { readWindowRole, type WindowRole } from './window-role';
import { startHostSettingsSync } from './host-settings';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './App.css';

/**
 * 先把「主进程要照着做的设置」送过去，再渲染。
 *
 * 放在渲染之前而不是某个组件的 effect 里：索引启动（`WorkspaceSidebar`）与设置页的
 * 重建索引都依赖主进程已经拿到规则，而它们都在这之后才会跑。三个窗口都跑这份入口，
 * 各自推一份 —— 它们共用同一份存储，值一样。
 */
startHostSettingsSync();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

/**
 * 四个窗口跑同一份产物，只有这里分叉。角色来自 URL 查询串，**同步可读** ——
 * 等一次 IPC 再决定渲染什么，用户会先看到主界面闪一下（见 `window-role.ts`）。
 */
const role = readWindowRole(window.location.search);

const ROOT_BY_ROLE: Record<WindowRole, React.ReactNode> = {
  main: <App />,
  settings: <SettingsWindow />,
  theme: <ThemeWindow />,
  update: <UpdateWindow />
};

/** 白屏兜底卡片上的标题也得按角色换 —— 主题窗口白屏却报「Nexus failed to render」会让人找错地方。 */
const TITLE_KEY_BY_ROLE: Record<WindowRole, string> = {
  main: 'error.appTitle',
  settings: 'error.settingsTitle',
  theme: 'error.themeTitle',
  update: 'error.updateTitle'
};

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 最外层兜底：任何渲染期异常都降级成可见的错误卡片，而不是整窗白屏。 */}
    <ErrorBoundary titleKey={TITLE_KEY_BY_ROLE[role]}>{ROOT_BY_ROLE[role]}</ErrorBoundary>
  </React.StrictMode>
);
