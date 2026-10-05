import { ipcRenderer } from 'electron';
import { formatLogDetail, type LogLevel } from '@nexus/core';
import { IPC_CHANNELS, type RendererLogEntry } from '../ipc/channels.js';

/**
 * preload 自己的日志出口。
 *
 * ## 为什么单独一个模块
 *
 * 两个地方要用它：`index.ts`（bridge 里的监听器出错）与 `theme-boot.ts`（首帧主题取不到）。
 * 而 `theme-boot.ts` 是被 `index.ts` import 的 —— 把出口留在 `index.ts` 里会造出一个循环依赖。
 *
 * ## 为什么 preload 的日志不能靠渲染进程的 console 接管
 *
 * 渲染进程那一层接管的是它自己那个 world 的 `window.console`。preload 跑在 **isolated world**，
 * 两边不共享这个对象 —— preload 里 `console.error` 出去的东西渲染进程看不见，
 * 也就转发不到主进程。所以 preload 必须自己走这条通道。
 *
 * ## 为什么整段包在 try 里
 *
 * preload 里抛出的异常会把整个 bridge 带下去，而「记日志」绝不能成为那个原因 ——
 * 那会把一条无害的日志变成「应用完全没有 API 可用」。送不出去就算了。
 */
export function logFromPreload(level: LogLevel, message: string, detail?: unknown): void {
  try {
    const entry: RendererLogEntry = { level, message: `[Nexus Preload] ${message}` };
    const text = formatLogDetail(detail);
    if (text !== undefined) entry.detail = text;
    // `send` 而不是 `invoke`：日志不该让调用方等一次往返，也不该因为主进程忙而堆积未决的 promise。
    ipcRenderer.send(IPC_CHANNELS.writeLog, entry);
  } catch {
    // 这里**不**退回 `console.error`：preload 的 console 与渲染进程那个是两回事，
    // 回退只会绕一圈再失败一次。
  }
}
