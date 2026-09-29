// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 预览外壳与真界面**共用类名** —— 这正是「改主窗口样式时预览自动跟着变」的全部机制
 * （见 `settings/ThemePreview.tsx` 的文件头：另抄一份样式必然漂移，而漂移只有肉眼能发现）。
 *
 * 代价是这条耦合**没有任何东西看着**：
 *
 * - 真界面把一个类改了名（`.nexus-tab-bar` → `.nexus-tabs-bar`），主窗口照常好看，预览那一截
 *   却悄悄失去样式 —— 而预览只在主题窗口里、还得滚到右栏才看得见，可能几周没人发现。
 * - 真界面删掉一个类同理。
 * - 反过来，预览自己写错一个类名也不会报错，只是那一截变裸 DOM。
 *
 * 这条用例就是那道哨兵：两个方向都卡住 —— 外壳用到的类必须在样式表里有定义，且这个清单必须
 * 真的出现在 `ThemePreview.tsx` 里（否则清单自己会腐化成一份没人对的旧账）。
 *
 * **它不管什么**：预览自己的覆盖规则（`-webkit-app-region`、侧栏宽度那几条）刻意不跟随真界面；
 * 真界面新加的元素也不会自动出现在手搭的外壳里 —— 那两件事要人来判断，不是这条用例的职责。
 */

const SRC_DIR = path.resolve(__dirname, '../src');
const CSS_PATH = path.join(SRC_DIR, 'App.css');
const TSX_PATH = path.join(SRC_DIR, 'settings/ThemePreview.tsx');

/** 外壳逐段依赖的类名。少一个，那一段就退化成裸 DOM。 */
const SHELL_CLASSES = [
  'nexus-header-bar',
  'nexus-header-left',
  'nexus-header-center',
  'nexus-header-right',
  'nexus-filename',
  'nexus-window-controls',
  'nexus-window-button',
  'nexus-body',
  'nexus-activity-bar',
  'nexus-activity-icon',
  'nexus-activity-icon-active',
  'nexus-activity-panel',
  'nexus-workspace-sidebar',
  'nexus-sidebar-header',
  'nexus-sidebar-root',
  'nexus-sidebar-count',
  'nexus-tree-list',
  'nexus-tree-item',
  'nexus-tree-item-active',
  'nexus-tree-name',
  'nexus-main-content',
  'nexus-tab-bar',
  'nexus-tab',
  'nexus-tab-active',
  'nexus-tab-name',
  'nexus-status-bar',
  'status-bar-left',
  'status-bar-right',
  'status-dot',
  'status-text',
  'status-metric'
];

describe('预览外壳的类名契约', () => {
  it('每个类都在样式表里有定义', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf-8');
    // 用 `.名` 且后面不是 `[a-z-]`，避免 `.nexus-tab` 被 `.nexus-tab-bar` 蒙对。
    const missing = SHELL_CLASSES.filter((name) => !new RegExp(`\\.${name}(?![a-z-])`).test(css));

    expect(missing, `样式表里找不到这些类：${missing.join(', ')}`).toEqual([]);
  });

  it('清单与预览组件对得上（没有过期的旧账）', () => {
    const tsx = fs.readFileSync(TSX_PATH, 'utf-8');
    const stale = SHELL_CLASSES.filter((name) => !tsx.includes(name));

    expect(stale, `ThemePreview.tsx 里已经不用这些类：${stale.join(', ')}`).toEqual([]);
  });
});
