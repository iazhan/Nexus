/**
 * 编辑器工具栏与顶栏共用的图标。
 *
 * 规格照 `workspace-icons.tsx` 的 `TOOLBAR_PROPS`：14×14、`viewBox="0 0 24 24"`、
 * 线宽 2、`stroke="currentColor"`、`fill="none"`。工具栏按钮是 24×24（`.nexus-toolbar-button`），
 * 14px 图标在里面留出的呼吸位与工作区侧栏那一栏一致 —— 两栏并排看过去不会一大一小。
 *
 * **`CodeIcon` / `EyeIcon` 原来内联在 `App.tsx`**，现在搬到这里：工具栏的 surface 切换
 * 按钮也要画它们，而「同一个动作两处入口画两枚图标」迟早会漂成两个样子。
 * 顶栏那个按钮改为从本模块导入，形状与线宽一字未改。
 *
 * **颜色一律走 `currentColor`**：调用方按「默认 / 悬停 / 激活 / 禁用」给色。
 * `MoreIcon` 的三个点是**实心**的（`fill="currentColor"` + `stroke="none"`）——
 * 描边画点会得到一个空心小圈，缩到 14px 就只剩一个模糊的环。
 */

const PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/** 撤销：向左回转的箭头。 */
export const UndoIcon = (
  <svg {...PROPS}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);

/** 重做：撤销的镜像。 */
export const RedoIcon = (
  <svg {...PROPS}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </svg>
);

/** 查找：放大镜。 */
export const FindIcon = (
  <svg {...PROPS}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </svg>
);

/** 更多：横向三点。横向而不是纵向 —— 它挂在一条横栏的右端，纵向点会被读成「拖拽手柄」。 */
export const MoreIcon = (
  <svg {...PROPS}>
    <circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none" />
  </svg>
);

/** Source surface：代码尖括号。 */
export const CodeIcon = (
  <svg {...PROPS}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

/** Visual surface：预览小眼睛。 */
export const EyeIcon = (
  <svg {...PROPS}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
