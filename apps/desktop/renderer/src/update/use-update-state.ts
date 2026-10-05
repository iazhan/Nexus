/**
 * 订阅主进程的更新状态。
 *
 * **两件事一起做**：挂载时 `getUpdateState()` 取一次快照，之后靠 `onUpdateStateChanged` 跟进。
 * 只订阅是不够的 —— 广播是**增量**的，而窗口可能在广播之后才打开，那样新窗口会停在 `idle`
 * 直到下一次状态变化；而下载完成之后可能再也不变了（用户看到的是「尚未检查」）。
 *
 * 初始值与广播**谁先到都算对**：`getUpdateState` 是异步的，它回来时可能已经收到过广播
 * （检查很快，而一次 IPC 往返要几毫秒）。所以初始值只在**还没有值**时落地，
 * 不覆盖已经前进的状态。
 */

import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../ipc/channels.js';

/**
 * 全量订阅。更新窗口用它 —— 它要画进度条，而进度每秒变好几次，全量是对的。
 *
 * 只关心「要不要显示提示条」的地方用 `useUpdateNotice`，**别用这个**：那会让主窗口
 * 跟着下载进度重渲染几百次（理由见下面那个 hook）。
 */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let alive = true;

    const unsubscribe = window.nexus?.onUpdateStateChanged?.((next) => {
      if (alive) setState(next);
    });

    // 取不到就等广播 —— 这里没有「显示错误」的位置，状态行自己会表达。
    // 先把 promise 拿到手再判断，不写成 `?.().then(...)`：那个写法只在 `window.nexus`
    // 整个缺失时才安全，而「桥在、这一条通道不在」时它会在 `undefined` 上取 `.then` 直接抛。
    const initial = window.nexus?.getUpdateState?.();
    if (initial) {
      void initial
        .then((next) => {
          if (alive) setState((current) => current ?? next);
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  return state;
}

/** 提示条真正会读的那几个字段。其余（进度、速度、字节数）变了不该让主窗口重绘。 */
const NOTICE_FIELDS = ['phase', 'latest', 'skipped', 'remindAfter', 'current'] as const;

function noticeSignature(state: UpdateState): string {
  return NOTICE_FIELDS.map((field) => String(state[field] ?? '')).join('\u0000');
}

/**
 * 订阅更新状态，但**只在提示条关心的字段变化时**才重渲染。
 *
 * 为什么不能直接用 `useUpdateState`：下载中的 `download-progress` 每秒发好几次，
 * 全量订阅会让**整个主窗口**跟着重渲染 —— 而提示条的文案（`phase` + `latest`）在那期间
 * 一个字都没变。一个几十 MB 的安装包会重渲染几百次。
 *
 * 判据是**签名字符串相等就跳过**，而不是逐字段浅比较：字段固定五个、都是基本类型，
 * 拼一次字符串比写五个 `!==` 更不容易漏 —— 加字段时忘了加比较，那种缺陷是静默的。
 */
export function useUpdateNotice(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let alive = true;
    let lastSignature = '';

    const accept = (next: UpdateState) => {
      if (!alive) return;
      const signature = noticeSignature(next);
      if (signature === lastSignature) return;
      lastSignature = signature;
      setState(next);
    };

    const unsubscribe = window.nexus?.onUpdateStateChanged?.(accept);

    // 初始快照只在**还没收到过广播**时落地：它是异步取的，回来时状态可能已经前进了
    // （检查很快，而一次 IPC 往返要几毫秒），拿旧值覆盖会让提示条退回上一阶段。
    // 先把 promise 拿到手再判断，理由与 `useUpdateState` 那条相同。
    const initial = window.nexus?.getUpdateState?.();
    if (initial) {
      void initial
        .then((next) => {
          if (lastSignature === '') accept(next);
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  return state;
}
