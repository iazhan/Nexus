/**
 * 查看器共用的缩放逻辑 —— PDF 与图片两处都用它。
 *
 * 放在 `viewer/` 这一层而不是留在 `pdf/` 下，是因为**同一个应用里两个查看器的缩放口径
 * 必须一样**：上下限、步进、滚轮手感各写一份，迟早出现「PDF 能放到 300%、图片只能到
 * 200%」这类说不清谁对的分歧。
 *
 * 这里只放**与文档格式无关**的部分。PDF 的 `BASE_SCALE`（1/72 英寸 → CSS 像素的基准换算）
 * 与分页几何留在 `pdf/pdf-layout.ts`。
 *
 * 判据（错法在画面上看不出来，只能靠数字钉住）：
 * - 夹不住只会「按钮点了没反应」；
 * - 步进不取整只会「显示 125% 但内部是 1.2499999999999998」，而判定到顶的等号跟着失灵；
 * - 滚轮用加法而不是指数，会「滚到顶被夹住之后再滚回来回不到原值」。
 */

/**
 * 缩放区间。
 *
 * 下限 **0.1** 而不是 0.5：图片查看器的「适合窗口」要装得下一张 4000px 的照片 ——
 * 在 1200×700 的内容区里那算出来是 **0.23**。下限若留在 0.5，夹完之后图仍然看不全，
 * 「适合窗口」这个按钮就等于失效（而这是图片查看器的第一诉求）。对 PDF 而言这也是
 * 纯增益：能缩到更小。
 *
 * 上限 300% 是「看清一个小字号注释」。
 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;

/** 100%。存的是**倍率**不是最终 scale —— 各查看器自己决定「100% 对应什么物理尺寸」。 */
export const ZOOM_DEFAULT = 1;

/**
 * 把任意数字夹进缩放区间。
 *
 * **非有限数回落 100%**：`NaN` / `Infinity` 都是算错了的产物（除零、没量到尺寸），
 * 而 `canvas.width = NaN` 不抛错、只是把画布设成 0 —— 症状是「缩放之后整页变白」。
 * 有限的越界值则**夹紧**而不是回落：`0.1` 是「想再小一点」的合理意图，夹到下限比
 * 跳回 100% 更贴近用户按下去时想要的东西。
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/**
 * 走一档。取两位小数是因为 `0.5 + 0.25 × 3` 在二进制里是 `1.2499999999999998` ——
 * 它会被原样显示成「125%」，而判定「到顶了没有」用的等号也会跟着失灵。
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const next = clampZoom(current) + direction * ZOOM_STEP;
  return clampZoom(Number(next.toFixed(2)));
}

/**
 * 缩放的百分比**数字部分**（不带 `%`）。
 *
 * 输入框用它而不是「带后缀的字符串」：把 `100%` 塞进 `value`，用户每次改数字都得先删掉
 * 那个 `%`。后缀由渲染层单独画一个 `<span>`，与输入框本身无关。
 *
 * 四舍五入到整数 —— 显示 `99.99999` 只会让人怀疑自己点错了。
 */
export function zoomPercent(scale: number): string {
  return String(Math.round(clampZoom(scale) * 100));
}

/**
 * 「适合窗口」对应的倍率：宽高**同时**放得下。
 *
 * 与「适合宽度」的差别在长图上：一张 800×4000 的长截图按宽度铺满之后纵向仍然溢出，
 * 用户还是看不全 —— 而图片查看器的第一诉求恰恰是「先看见整张」。
 * PDF 不用它，是因为页有固定的纸张比例，按宽度算就够了。
 *
 * 入参是**已经换算到同一量纲**的两对尺寸。量不出来时回落 100%，理由同 `fitWidthZoom`。
 */
export function fitZoom(
  naturalWidth: number,
  naturalHeight: number,
  availableWidth: number,
  availableHeight: number
): number {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return ZOOM_DEFAULT;
  if (!(availableWidth > 0) || !(availableHeight > 0)) return ZOOM_DEFAULT;
  return clampZoom(
    Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight)
  );
}

/**
 * 滚轮一格大约 100，乘这个系数后每格约 1.1 倍 —— 再快就调不准。
 *
 * 与图谱面板**同值**：同一个应用里两处滚轮缩放的手感必须一致，各调各的迟早会漂。
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.001;

/**
 * 滚轮增量 → 缩放因子。向上滚（`deltaY < 0`）放大。
 *
 * 用指数而不是加法：连续滚 N 格的因子等于一格因子的 N 次方，于是「滚回去」必然回到
 * 原处。加法做不到这一点（每格加 0.1，滚到顶被夹住之后再滚回来就回不到原值）。
 *
 * 非有限数返回 1（不动）—— `deltaY` 是 `NaN` 的话因子会变成 `NaN`，而 `NaN` 一旦进了
 * `canvas.width` 就是把画布设成 0，症状是「缩放之后整页变白」。
 */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
}
