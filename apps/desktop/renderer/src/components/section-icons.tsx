/**
 * 设置页左栏各分组的图标。
 *
 * **为什么单独一个模块而不是留在 `SettingsView.tsx`**：分组表在 `settings/registry.ts`，
 * 那里是这个项目的「分组唯一数据源」（左栏、内容区、外观菜单都读它）。图标挂到调用方就等于
 * 在 `SettingsView` 里再列一遍全部分组，加一个分组要改两处 —— 这正是注册表存在的理由。
 *
 * 规格：16×16、`viewBox="0 0 24 24"`、线宽 1.8、`stroke="currentColor"`、`fill="none"`。
 * 线宽取 1.8 而不是活动栏那套 1.6：图标是 16px 不是 20px，按 24 视箱等比缩放后 1.6 只剩
 * 1.07px，比同一栏里的文字（13px）细一截，看着发虚。
 *
 * **颜色一律走 `currentColor`**，由调用方按「默认 / 悬停 / 选中」三态给色 —— 图标自己持有
 * 颜色就得多写三条覆盖规则，还会漏掉 `planned` 那一态。
 */

const PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/** 通用：三条滑杆各带一个钮。**不用齿轮** —— 齿轮已经是活动栏底部的「打开设置」入口，
 *  在这里再来一枚会读成「点它进设置」，而它其实是设置里的一个分组。 */
export const GeneralIcon = (
  <svg {...PROPS}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <circle cx="9" cy="7" r="2.2" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <circle cx="15" cy="12" r="2.2" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="7" cy="17" r="2.2" />
  </svg>
);

/** 编辑器：铅笔。 */
export const EditorIcon = (
  <svg {...PROPS}>
    <path d="M4 20l1-4L16.4 4.6a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />
    <path d="M14.6 6.4l3 3" />
  </svg>
);

/** 阅读：翻开的书。**不用「文档纸」** —— 与编辑器分组的铅笔太像，两枚图标读起来是一件事。 */
export const ViewerIcon = (
  <svg {...PROPS}>
    <path d="M12 7c-1.7-1.4-3.8-2-6.5-2A1.5 1.5 0 0 0 4 6.5v10A1.5 1.5 0 0 0 5.5 18c2.7 0 4.8.6 6.5 2" />
    <path d="M12 7c1.7-1.4 3.8-2 6.5-2A1.5 1.5 0 0 1 20 6.5v10a1.5 1.5 0 0 1-1.5 1.5c-2.7 0-4.8.6-6.5 2" />
    <path d="M12 7v13" />
  </svg>
);

/** 文件与链接：文件夹。**不用「文档纸」** —— 那与编辑器分组的铅笔太像，两枚图标读起来是一件事。 */
export const FilesIcon = (
  <svg {...PROPS}>
    <path d="M3 7.5A2 2 0 0 1 5 5.5h3.5a2 2 0 0 1 1.6.8l1.1 1.5H19a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

/** 外观：调色盘。四个色点代表「配色是一组选择」，不是装饰。 */
export const AppearanceIcon = (
  <svg {...PROPS}>
    <path d="M12 3a9 9 0 1 0 0 18c1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-1 .8-1.8 1.8-1.8h1.8A4.5 4.5 0 0 0 21 10.6 8.6 8.6 0 0 0 12 3z" />
    <circle cx="7.6" cy="11.4" r="1.1" />
    <circle cx="10.6" cy="7.4" r="1.1" />
    <circle cx="15.6" cy="8.6" r="1.1" />
    <circle cx="17.4" cy="12.8" r="1.1" />
  </svg>
);

/** 快捷键：键盘。三行按键 + 空格条。 */
export const KeybindingsIcon = (
  <svg {...PROPS}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 9.6h.01M10 9.6h.01M13.5 9.6h.01M17 9.6h.01M6.5 12.6h.01M10 12.6h.01M13.5 12.6h.01M17 12.6h.01M8.5 15.4h7" />
  </svg>
);

/** 插件：四方块。**与活动栏的 `extensions` 同形** —— 同一件事在两处该长得一样。 */
export const PluginsIcon = (
  <svg {...PROPS}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

/** 同步：云 + 上下箭头。 */
export const SyncIcon = (
  <svg {...PROPS}>
    <path d="M17.5 18H9a6.5 6.5 0 1 1 6.2-8.4h1.7a4.2 4.2 0 1 1 .6 8.4z" />
    <path d="M12 11.6v5" />
    <path d="M10.2 13.4 12 11.6l1.8 1.8" />
  </svg>
);

/** 关于：信息圆圈。**不用齿轮**（那是设置本身）、**不用问号**（那读成「帮助」）。 */
export const AboutIcon = (
  <svg {...PROPS}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11.2" x2="12" y2="16.6" />
    <circle cx="12" cy="7.6" r="0.95" fill="currentColor" stroke="none" />
  </svg>
);

/** 数据：数据库圆柱。 */
export const DataIcon = (
  <svg {...PROPS}>
    <ellipse cx="12" cy="6.5" rx="7.5" ry="3.2" />
    <path d="M4.5 6.5v11c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2v-11" />
    <path d="M4.5 12c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2" />
  </svg>
);
