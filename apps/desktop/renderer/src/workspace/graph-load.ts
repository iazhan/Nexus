/**
 * 图谱侧取数的**四态**。
 *
 * 渲染顺序固定为 **错误 → 加载中 → 空 → 画布/列表**，四态互斥。
 *
 * ## 为什么不用 `window.nexus?.x?.(…) ?? 空值`
 *
 * 可选链加 `??` 会把「桥没就绪 / preload 挂了」静默变成「工作区是空的」——
 * 两者在界面上长得一模一样，用户看不出区别，而且那条路径上一行日志都没有。
 * 所以桥不存在时**抛错**、走错误分支：宁可说「出错了」，也不要把失败渲染成结论。
 *
 * ## `loading` 只在**第一次**取数时成立
 *
 * 之后每次重取（切筛选、切范围、索引变化）都保留上一次的结果在屏幕上 ——
 * 否则每点一下筛选就闪一次加载态。与 react-query 的 `isLoading` / `isFetching`
 * 之分是同一件事：只有「还没有任何数据」才算加载中。
 *
 * 两个消费者（画布与清单）各持有自己的 `phase`，但它们用的是同一个类型与同一条
 * 判据 —— 四态的实现可以有两份，语义只能有一份。
 */
export type GraphPhase = 'loading' | 'ready' | 'error';

/** 取一次桥，**不存在就抛**。 */
export function requireGraphBridge(): NonNullable<Window['nexus']> {
  const bridge = window.nexus;
  if (bridge === undefined || bridge === null) {
    throw new Error('Nexus bridge unavailable');
  }
  return bridge;
}
