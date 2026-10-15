/**
 * 图谱**出生动画的几何**：新出现的点从多大长到多大、外圈那道光晕有多宽。
 *
 * ## 为什么单独成一个模块
 *
 * 这两条算式原来直接写在 `GraphPanel.tsx` 的绘制 effect 里（`0.4 + 0.6 * birth`）。
 * 写在 effect 里就**只能靠肉眼验** —— 画布上的东西从外部定位不到，而出生动画只持续
 * 几百毫秒，肉眼既看不出「光晕有没有收缩」，更看不出「动画结束后还留没留一圈外环」。
 * 而「留了一圈常驻外环」恰恰是这个特性最容易出的错：它只在动画结束之后才出现，
 * 那时候没人盯着看。
 *
 * 抽成纯函数之后，这两条算式可以按「半径」直接断言，不需要 canvas。
 *
 * ## 光晕的意义是「告诉你什么变了」
 *
 * 只做「变大 + 淡入」在一个已经有几十个点的画布上不够醒目：变大的那一点太小、
 * 淡入的那一点本来就在别处的点之间。外扩的一圈是**位移**，在静止的背景里最先被看到。
 */

/**
 * 出生起点占最终半径的比例。
 *
 * 不是 0：从零长起来看着像「凭空冒出来」，而且一个 0 半径的圆在某些缩放级别下
 * 只有亚像素，前几帧等于没画。
 */
const BIRTH_MIN_RADIUS_FACTOR = 0.4;

/** 光晕在 `birth = 0` 时比**实体**多出多少倍的基础半径。 */
const BIRTH_HALO_GROWTH = 1.4;

/**
 * 光晕至少比实体宽这么多**屏幕像素**。
 *
 * 画布是在屏幕坐标里画的（见 `graph-view.ts` 头注释），所以这里是一个像素常量，
 * 不除缩放：缩到最小时节点只有几个像素宽，没有这条下限光晕就细到看不见。
 */
const BIRTH_HALO_MIN_PX = 2;

/** 光晕的不透明度上限。再高就盖过实体本身，看着像一个实心的大点。 */
export const BIRTH_HALO_ALPHA = 0.4;

/**
 * 出生进度 → 半径系数。`0` 刚出现（0.4 倍），`1` 完全就位（1 倍）。
 *
 * 越界一律夹住：调用方给的是 `birthProgressOf()` 的结果（已经夹过），
 * 但这条算式还要给别的地方用，不该依赖调用方的自律。
 */
export function birthRadiusFactor(birth: number): number {
  const progress = Number.isFinite(birth) ? Math.min(1, Math.max(0, birth)) : 1;
  return BIRTH_MIN_RADIUS_FACTOR + (1 - BIRTH_MIN_RADIUS_FACTOR) * progress;
}

/**
 * 光晕的半径（屏幕坐标）。**`null` = 不画。**
 *
 * `baseRadius` 是**完全就位后**的半径（已经乘过 `view.scale`），不是当前帧画出来的那个 ——
 * 传当前半径的话，光晕会跟着实体一起缩小，就不是「收缩的光环」而是「一起缩的小点」。
 *
 * ## 为什么用 `null` 而不是「等于实体半径」
 *
 * `birth = 1` 时算式本身会退化成 `实体 + 2px`，仍然是个环。让调用方去判断
 * 「到 1 了就别画」，等于把这条判据散在每个调用点；返回 `null` 让「动画结束就没有外圈」
 * 只在一个地方成立、也只在一个地方能测。
 */
export function birthHaloRadius(baseRadius: number, birth: number): number | null {
  const progress = Number.isFinite(birth) ? Math.min(1, Math.max(0, birth)) : 1;
  if (progress >= 1) return null;

  const drawn = baseRadius * birthRadiusFactor(progress);
  return drawn + baseRadius * BIRTH_HALO_GROWTH * (1 - progress) + BIRTH_HALO_MIN_PX;
}

/** 光晕的不透明度：与半径一起收敛到 0。 */
export function birthHaloAlpha(birth: number): number {
  const progress = Number.isFinite(birth) ? Math.min(1, Math.max(0, birth)) : 1;
  return BIRTH_HALO_ALPHA * (1 - progress);
}
