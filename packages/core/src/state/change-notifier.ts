/**
 * 「状态跃迁」的通知器：订阅者只在**下一拍**被叫醒，同一拍的多次跃迁只叫一次。
 *
 * 两个注册表（编辑器扩展宿主、附件渲染器登记表）共用它，所以它们对外是同一套形状 ——
 * 调用方不需要记住「哪一个同步通知、哪一个异步」。
 *
 * ## 为什么必须推迟一拍
 *
 * 状态位是在**别处**被翻真的，而那些地方有一处在 React 渲染过程中：`React.lazy` 的工厂
 * 只在组件第一次渲染时被调用，它一跑 `requested` 就翻真。同步把订阅者叫起来，等于在渲染
 * 期间 setState —— React 会报「渲染期间更新另一个组件」，并可能丢掉这次更新。
 * 推迟到微任务之后，通知一定落在提交之后。
 *
 * 反过来，**不能靠订阅者自己推迟**：那样每个订阅者都要知道这个坑，而漏掉的那个不会报错，
 * 只在某些时序下丢更新。
 *
 * ## 为什么合并
 *
 * 一次加载会连翻两三个位（`requested` → `resolved`），逐个通知就是几次多余的重渲染。
 * 合并后每拍最多一次；代价是订阅者看不到中途那些态，而它们本来就是瞬时的。
 */

export interface ChangeNotifier {
  /**
   * 订阅状态跃迁。返回退订函数。
   *
   * **组件卸载必须调用它** —— 不调是泄漏，而症状是「面板闪烁」这类难查的问题：
   * 已卸载的组件仍被叫醒，读到的是它最后一次渲染时的闭包。
   */
  subscribe(listener: () => void): () => void;

  /**
   * 已经发出过多少次通知（每次通知 +1，合并算一次）。
   *
   * `useSyncExternalStore` 的快照用它：状态是若干对象的若干字段，没有「一个值」可快照，
   * 而快照必须是可比较的稳定值（每次返回新对象会让 React 判定成「一直在变」）。
   */
  readonly revision: number;

  /** 报告一次跃迁。同一拍里多次调用只发一次通知。 */
  notify(): void;
}

export function createChangeNotifier(): ChangeNotifier {
  const listeners = new Set<() => void>();
  let revision = 0;
  let scheduled = false;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get revision() {
      return revision;
    },

    notify() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        // `revision` 与通知一起推进：这样「快照变了」与「订阅者被叫醒」永远同步，
        // 不会出现「快照已变但没人收到通知」的中间态被 React 读到。
        revision += 1;
        // 复制一份再遍历：监听器里退订（组件卸载）不该影响这一轮剩下的订阅者。
        for (const listener of [...listeners]) listener();
      });
    }
  };
}
