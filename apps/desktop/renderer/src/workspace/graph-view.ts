/**
 * 图谱画布的**视图变换**：缩放与平移。
 *
 * ## 为什么不直接把变换压进 canvas context
 *
 * `context.scale()` 会把线宽、字号一起放大 —— 缩小时标签小到读不出，放大时糊成一片。
 * 所以这里只算「图坐标 → 屏幕坐标」这一个投影，绘制仍在屏幕坐标里做：
 * 节点半径随缩放变（视觉上应该跟着变），标签字号不变（文字应该始终可读）。
 *
 * ## 投影是唯一的，反投影也是
 *
 * 命中检测必须先 `unprojectPoint()` 回到图坐标再比距离。少了这一步的症状是
 * **缩放之后点不中**：画在哪、点在哪，两者用了不同的坐标系，而画面看起来完全正常。
 *
 * 所有函数都是纯函数，返回新的视图对象 —— 拖拽时每帧都要算，原地改会让 React
 * 认不出变化（同一个引用 = 不重渲染），表现成「拖了没反应」。
 */
export interface GraphView {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface GraphPoint {
  x: number;
  y: number;
}

export const IDENTITY_VIEW: GraphView = { scale: 1, offsetX: 0, offsetY: 0 };

/** 缩放下限：再小就只剩一堆重叠的点，读不出结构。 */
export const MIN_SCALE = 0.3;
/** 缩放上限：再大单个节点就撑满整个面板，失去全局视角。 */
export const MAX_SCALE = 4;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function projectPoint(view: GraphView, x: number, y: number): GraphPoint {
  return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
}

export function unprojectPoint(view: GraphView, x: number, y: number): GraphPoint {
  return { x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale };
}

/**
 * 以 `anchor`（屏幕坐标）为不动点缩放。
 *
 * 「不动点」是这里的全部要点：不补偿偏移的话，放大时图会往左上角跑，
 * 用户想看清的那个点在视野外 —— 滚轮缩放最难用错的地方就在这。
 *
 * 推导：锚点下的图坐标 `g` 在缩放前后必须落在同一个屏幕位置。
 * `g = (anchor - offset) / scale`，缩放后要求 `anchor = g * scale' + offset'`，
 * 于是 `offset' = anchor - g * scale'`。
 */
export function zoomAt(view: GraphView, factor: number, anchorX: number, anchorY: number): GraphView {
  const nextScale = clampScale(view.scale * factor);
  if (nextScale === view.scale) return view;

  const target = unprojectPoint(view, anchorX, anchorY);
  return {
    scale: nextScale,
    offsetX: anchorX - target.x * nextScale,
    offsetY: anchorY - target.y * nextScale
  };
}

export function panBy(view: GraphView, deltaX: number, deltaY: number): GraphView {
  return { scale: view.scale, offsetX: view.offsetX + deltaX, offsetY: view.offsetY + deltaY };
}

/**
 * 让一组图坐标点**完整落进**视口，四周留 `padding` 像素。
 *
 * 空集合或退化尺寸（所有点重合、视口为 0）返回单位视图 —— 除以 0 会算出 `Infinity`，
 * 而 `Infinity` 一旦进了 scale，后面每一次投影都是 NaN，画面直接空白。
 */
export function fitView(
  points: readonly GraphPoint[],
  viewport: { width: number; height: number },
  padding: number
): GraphView {
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return IDENTITY_VIEW;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  // 可用区域要减去两侧的 padding；padding 大到把区域吃光时退化成 1，不能变成负数
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);

  // 全部点重合时 span 为 0 → 比例为 Infinity。取 1（保持原尺寸），只做居中。
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = clampScale(
    Math.min(spanX > 0 ? usableWidth / spanX : Infinity, spanY > 0 ? usableHeight / spanY : Infinity)
  );

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    scale,
    offsetX: viewport.width / 2 - centerX * scale,
    offsetY: viewport.height / 2 - centerY * scale
  };
}
