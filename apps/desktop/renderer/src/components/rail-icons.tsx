/**
 * 活动栏图标集。**真活动栏与主题窗口的预览外壳共用同一份图形。**
 *
 * 为什么抽出来：预览外壳的全部意义就是「真界面长什么样」，而两处各写一遍必然漂移 ——
 * 实测已经漂过一次：同一枚设置图标，真活动栏画成「圆 + 8 条分离的射线」（读作太阳），
 * 预览里画成同形状但射线更短，两边都不是齿轮，也都不是同一个东西。
 *
 * **这里只放 `<svg>` 里的图形，外壳由调用方按自己的规格包** —— 两个调用方只差尺寸
 * （真活动栏 20×20、预览外壳 18×18），把尺寸也搬进来就得再加一个参数，而参数化一个
 * 「只是尺寸不同」的图标集不如让调用方自己声明。
 *
 * 颜色一律走 `currentColor`：图标自己持有颜色就等于多出一套色板，主题一换就会露出破绽。
 */

import React from 'react';

/** 活动栏上的图标名。真活动栏的 7 个文档级入口 + 底部的设置入口。 */
export type RailIconName =
  | 'workspace'
  | 'outline'
  | 'search'
  | 'tags'
  | 'graph'
  | 'history'
  | 'extensions'
  | 'settings';

export const RAIL_ICON_SHAPES: Record<RailIconName, React.ReactNode> = {
  workspace: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  outline: (
    <>
      <line x1="9" y1="6" x2="21" y2="6" />
      <line x1="9" y1="12" x2="21" y2="12" />
      <line x1="9" y1="18" x2="15" y2="18" />
      <line x1="4" y1="6" x2="4" y2="6" />
      <line x1="4" y1="12" x2="4" y2="12" />
      <line x1="4" y1="18" x2="4" y2="18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  tags: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <circle cx="11" cy="18" r="2.4" />
      <path d="M8.1 7 15.9 7.7M7.2 8.2l2.7 7.6M16.6 10.2l-4.1 5.6" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4.5V9h4.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  extensions: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  /**
   * 齿轮。**齿必须与轮体连成一条闭合轮廓** —— 画成「一个圆 + 一圈分离的短射线」读出来是太阳
   * （旧版就是这个形状，在 20px 下尤其明显）。这条路径是标准的 8 齿轮廓，中心留 r=3 的孔。
   */
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  )
};

/**
 * 按调用方的规格包一层 `<svg>`。两个调用方只差尺寸与 `key`，所以壳子做成函数而不是常量。
 */
export function railIcon(name: RailIconName, size: number, key?: string): React.ReactNode {
  return (
    <svg
      key={key ?? name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {RAIL_ICON_SHAPES[name]}
    </svg>
  );
}
