import React, { useEffect, useRef } from 'react';
import { createSourceEditorView } from '@nexus/editor';
import { DarkIcon, LightIcon } from '../components/theme-icons.js';
import { railIcon } from '../components/rail-icons.js';
import { useLocale, useTheme } from '../hooks.js';

/**
 * 实时预览：**一扇真主窗口 + 一组控件样例**。
 *
 * 只用真类名与真编辑器工厂 —— 按钮复用的是设置页的 `.nexus-settings-option`、输入框复用命令面板的
 * `.nexus-command-palette-input`、编辑区是**真的 CodeMirror 视图**（`createSourceEditorView` 建一个
 * 只读实例）。外壳的每一段也都挂真类名：`.nexus-header-bar` / `.nexus-activity-bar` /
 * `.nexus-activity-panel` / `.nexus-workspace-sidebar` / `.nexus-tree-item` / `.nexus-tab-bar` /
 * `.nexus-tab` / `.nexus-status-bar` / `.status-dot`。
 *
 * 为什么不能用色块拼一个：预览的样式一旦是另抄一份，它就会与真组件漂移，而漂移只有肉眼能发现。
 * 复用同一个类名 + 同一个编辑器工厂，预览就是「真实界面的一小块」。
 *
 * **为什么外壳是手搭的、不是渲染真组件**：真 `WindowControls` 点一下会关掉当前窗口，真
 * `WorkspaceSidebar` 要工作区与索引，真 `TabBar` 在只有一个文档时直接返回 `null`。手搭的代价只是
 * 类名要跟着改（那是显式的契约），换来的是预览**没有任何副作用**，而且能整块 `aria-hidden` ——
 * 真组件里的按钮是可聚焦的，塞进 `aria-hidden` 区域反而制造无障碍违规。
 *
 * **外壳必须画全**，不能只画编辑区：主题改的从来不只是正文。标题栏、活动栏的选中态、侧栏的
 * 树、标签页的激活态、状态栏的点与度量，各吃一批不同的 token；少画哪一段，那一段的 token 就只能
 * 靠猜。这也正是这个窗口存在的理由 —— 在设置页的单列布局里，这一整块根本没地方放。
 *
 * CodeMirror 视图只需建一次：`getEditorTheme()` 产出的是 `var(--nexus-*)`，变量值一变 CSS 自己
 * 就重算了，不需要重建视图。
 */

const SAMPLE = [
  '# Notes',
  '',
  '**强调**与 *斜体*，行内 `code`，还有 [链接](https://example.com)。',
  '',
  '```ts',
  'export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);',
  '```',
  '',
  '> 引用块用的是 `bg-quote`。',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| accent | `accent-solid` |'
].join('\n');

/**
 * 活动栏图标：**与真活动栏共用同一份图形**（`components/rail-icons.tsx`），这里只包成 18×18。
 * 预览外壳的全部意义就是「真界面长什么样」，两处各画一份必然漂移 —— 实测已经漂过一次。
 */
const RAIL_ICONS = (['workspace', 'outline', 'search', 'tags'] as const).map((name) =>
  railIcon(name, 18)
);

/** 侧栏的树：两目录 + 两文件，其中一个文件是「当前打开的」。缩进由 `--depth` 控制。
 *  名字取中性的通用文档名 —— 预览是给所有人看的样张，不该出现某一台机器上的具体项目文件。 */
const TREE: readonly { name: string; depth: number; dir?: boolean; active?: boolean }[] = [
  { name: 'docs', depth: 0, dir: true },
  { name: 'guide.md', depth: 1, active: true },
  { name: 'changelog.md', depth: 1 },
  { name: 'assets', depth: 0, dir: true },
  { name: 'cover.png', depth: 1 }
];

const TABS = ['guide.md', 'changelog.md'];

const CodePreview: React.FC = () => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = createSourceEditorView({
      parent: host,
      doc: SAMPLE,
      readOnly: true,
      includeHistory: false
    });
    return () => view.destroy();
  }, []);

  return <div className="nexus-theme-preview-code" ref={hostRef} data-theme-preview-code="" />;
};

/**
 * 一扇真主窗口。整块 `aria-hidden` —— 它是一张「当前主题下界面长什么样」的图，
 * 里面的文字不是给读屏读的内容。
 */
const ShellPreview: React.FC = () => {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();

  return (
    <div className="nexus-theme-preview-shell" data-theme-preview-shell="" aria-hidden="true">
      <header className="nexus-header-bar">
        <div className="nexus-header-left">
          {/* 预览画的是**带工作区**的窗口（侧栏有树），所以标题取 `app.name.workspace`
              —— 与真主窗口在同一种状态下的取值一致（`App.tsx` 按有没有工作区二选一）。 */}
          <span className="nexus-app-title">{t('app.name.workspace')}</span>
          {/* 只画一个菜单名：这扇预览窗宽 ~460px，真标题栏那排菜单（File / Edit / View…）
              在这里会把文件名挤成「d…」，反而看不出标题栏在画什么。 */}
          <span className="nexus-theme-preview-menu">{t('menu.file')}</span>
        </div>
        <div className="nexus-header-center">
          <span className="nexus-filename">guide.md</span>
        </div>
        <div className="nexus-header-right">
          {/* 主题切换键画的是**切过去之后**那一边的图标，与真标题栏一致 */}
          <span className="nexus-header-button">
            {resolvedTheme.type === 'light' ? DarkIcon : LightIcon}
          </span>
          <span className="nexus-header-button">
            <CodeGlyph />
          </span>
          <span className="nexus-window-controls">
            <span className="nexus-window-button">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
              </svg>
            </span>
            <span className="nexus-window-button">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect
                  x="0.5"
                  y="0.5"
                  width="9"
                  height="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            </span>
            <span className="nexus-window-button nexus-window-button-close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 0 10 10M10 0 0 10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </span>
          </span>
        </div>
      </header>

      <div className="nexus-body">
        <nav className="nexus-activity-bar">
          {RAIL_ICONS.map((icon, index) => (
            <span
              key={index}
              className={`nexus-activity-icon${index === 0 ? ' nexus-activity-icon-active' : ''}`}
            >
              {icon}
            </span>
          ))}
          <span className="nexus-activity-icon nexus-activity-icon-bottom">
            {railIcon('settings', 18)}
          </span>
        </nav>

        <div className="nexus-activity-panel nexus-activity-panel-open">
          <div className="nexus-workspace-sidebar">
            <div className="nexus-sidebar-header">
              <span className="nexus-sidebar-root">vault</span>
              <span className="nexus-sidebar-count">5</span>
            </div>
            <ul className="nexus-tree-list">
              {TREE.map((node) => (
                <li
                  key={node.name}
                  className={`nexus-tree-item ${node.dir ? 'nexus-tree-dir' : 'nexus-tree-file'}${
                    node.active ? ' nexus-tree-item-active' : ''
                  }`}
                  style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                >
                  {node.dir && (
                    <span className="nexus-tree-chevron nexus-tree-chevron-open">
                      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                        <path d="M2 1 6 4 2 7" fill="currentColor" />
                      </svg>
                    </span>
                  )}
                  <span className="nexus-tree-name">{node.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <main className="nexus-main-content">
          <div className="nexus-tab-bar">
            {TABS.map((name, index) => (
              <span
                key={name}
                className={`nexus-tab${index === 0 ? ' nexus-tab-active' : ''}`}
              >
                <span className="nexus-tab-name">{name}</span>
              </span>
            ))}
          </div>
          <CodePreview />
        </main>
      </div>

      <footer className="nexus-status-bar">
        <div className="status-bar-left">
          <span className="status-dot saved" />
          <span className="status-text">{t('save.saved')}</span>
        </div>
        <div className="status-bar-right">
          <span className="status-metric">{t('status.lineColumn', { line: '3', column: '12' })}</span>
          <span className="status-metric status-format">Markdown</span>
        </div>
      </footer>
    </div>
  );
};

/** 与 `components/theme-icons.tsx` 同形，但只在这一处用 —— 按那里的边界留在调用方。 */
const CodeGlyph = (): React.ReactElement => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

/**
 * 外壳画不到的那几样：状态条（`status-warning-*` / `status-error-*`）、选中底色
 * （`selection-bg`）、命令面板输入框、按钮的实心与描边两态。它们都不是「窗口的一段」，
 * 所以并列在外壳下面，而不是硬塞进那扇窗里。
 */
export const ThemePreview: React.FC = () => {
  const { t } = useLocale();

  return (
    <aside className="nexus-theme-preview" data-theme-preview="" aria-label={t('theme.preview.title')}>
      <span className="nexus-theme-preview-title">{t('theme.preview.title')}</span>

      <ShellPreview />

      <div className="nexus-theme-preview-row">
        <span className="nexus-settings-option nexus-settings-option-active">
          {t('theme.preview.button')}
        </span>
        <span className="nexus-settings-option">{t('theme.preview.buttonGhost')}</span>
      </div>

      <input
        className="nexus-command-palette-input nexus-theme-preview-input"
        placeholder={t('cmd.placeholder')}
        readOnly
        data-theme-preview-input=""
      />

      <div className="nexus-theme-preview-status" data-status="warning">
        {t('theme.preview.warning')}
      </div>
      <div className="nexus-theme-preview-status" data-status="error">
        {t('theme.preview.error')}
      </div>

      <p className="nexus-theme-preview-paragraph">
        {t('theme.preview.selectionBefore')}
        <span className="nexus-theme-preview-selection">{t('theme.preview.selection')}</span>
        {t('theme.preview.selectionAfter')}
      </p>
    </aside>
  );
};
