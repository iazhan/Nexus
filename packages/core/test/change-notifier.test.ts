import { describe, it, expect, vi } from 'vitest';
import { createChangeNotifier } from '../src/index.js';

/** 让 `queueMicrotask` 排下的那一拍跑完。 */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 状态跃迁通知器。
 *
 * 三条性质都是**被需求逼出来的**，不是风格选择：
 *
 * 1. **推迟一拍** —— `React.lazy` 的工厂在渲染过程中调用，同步通知订阅方会撞上
 *    React 的「渲染期间更新另一个组件」。
 * 2. **同拍合并** —— 一次加载会连翻两三个状态位，逐个通知就是让订阅方白重渲染两三次。
 * 3. **能退订** —— 组件卸载后回调还在被叫醒就是泄漏，而症状是「面板闪烁」这类极难定位的问题。
 *
 * 所以这里的用例是这三条的**判据**，不是实现细节的复述：换一种实现只要仍然满足它们就该绿。
 */
describe('createChangeNotifier', () => {
  it('通知推迟到下一拍，revision 同步不变', async () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);

    notifier.notify();

    // 这一条是「推迟」的判据：若改成同步派发，这里立刻就会红
    expect(listener).not.toHaveBeenCalled();
    expect(notifier.revision).toBe(0);

    await nextTick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(notifier.revision).toBe(1);
  });

  it('同一拍的多次通知合并成一次，revision 只加一', async () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);

    // 一次加载会连翻两三个位（requested → resolved），逐条派发就是白重渲染
    notifier.notify();
    notifier.notify();
    notifier.notify();

    await nextTick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(notifier.revision).toBe(1);

    // 但下一拍再通知是**新的一次**：合并只限同一拍，不能把后续通知也吞掉
    notifier.notify();
    await nextTick();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(notifier.revision).toBe(2);
  });

  it('退订之后不再被叫醒 —— 反面判据：不解除就是泄漏', async () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();
    const unsubscribe = notifier.subscribe(listener);

    unsubscribe();
    notifier.notify();
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
    // revision 照旧推进：它是「通知发过多少次」，不是「有多少订阅者」
    expect(notifier.revision).toBe(1);
  });

  it('派发途中退订不会漏掉本轮、也不会在下一轮复活', async () => {
    const notifier = createChangeNotifier();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    const first = vi.fn(() => unsubscribeSecond());

    notifier.subscribe(first);
    unsubscribeSecond = notifier.subscribe(second);

    // 遍历的是快照：派发途中改订阅表不能把本轮派发拆坏（Set 边遍历边删是未定义顺序）
    notifier.notify();
    await nextTick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    notifier.notify();
    await nextTick();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
