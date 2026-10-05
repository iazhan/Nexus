/**
 * 渲染进程的日志出口。
 *
 * ## 为什么渲染进程也要记日志
 *
 * 用户报的问题**大多数发生在渲染进程**：白屏、某个面板加载不出来、保存报错、IPC 失败。
 * 这些消息现在只进 DevTools 控制台 —— 而用户不会打开 DevTools，就算打开了也不知道该复制什么。
 * 渲染进程没有文件系统，所以这里把消息经 `writeLog` 交给主进程写盘。
 *
 * ## 为什么要接管 `console.error` / `console.warn`
 *
 * 全仓有二十多处 `console.error('...', err)`，都是「某个操作失败了」的现场。逐个改成
 * `logError` 是一次大 diff、且**下一次有人写新代码时又会漏**。接管这两个方法等于一次性
 * 覆盖全部现有与将来的调用点，代价只有这一处。
 *
 * 刻意**不接管** `console.log` / `console.info` / `console.debug`：它们承载的是
 * 开发期的临时输出（React 的调试日志、随手打的探针），量不可控，而进日志的价值很低。
 * 需要记的东西用 `logInfo` / `logDebug` 显式调用 —— 「随手打的」和「要留档的」本来就该分开。
 *
 * ## 不接管时的调用路径，与接管后的，是同一份输出
 *
 * `logError` 与接管后的 `console.error` 都先调**原始** `console.error` 再送 IPC ——
 * 所以 DevTools 里看到的东西和之前完全一样，不会因为加了这一层而少一块。
 *
 * ## 不做限流，这是有意的
 *
 * 进 `console.error` 的应当是**异常路径**（一次保存失败、一个面板加载不出来），
 * 不是热路径。真出现「每次重绘都报一条」的情况，那是那个调用点的问题（该降级成 `logDebug`
 * 或干脆去掉），限流只会把它盖住。日志量真正要控的是**级别**，那一层在主进程。
 */

import { formatLogDetail, type LogLevel } from '@nexus/core';

/**
 * 原始的 `console.error` / `console.warn`。**在模块求值时绑定** ——
 * 那时接管还没发生，所以拿到的一定是原生的那两个。
 */
const rawConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console)
};

let installed = false;

function send(level: LogLevel, message: string, detail?: string): void {
  try {
    const entry = detail === undefined ? { level, message } : { level, message, detail };
    window.nexus?.writeLog?.(entry);
  } catch {
    // 桥不在（测试、或某个窗口形态下没透出这条通道）时静默 ——
    // 记日志失败绝不该反过来让调用方出错。
  }
}

function write(level: LogLevel, message: string, detail?: unknown): void {
  if (detail === undefined) rawConsole[level === 'warn' ? 'warn' : 'error'](message);
  else rawConsole[level === 'warn' ? 'warn' : 'error'](message, detail);
  send(level, message, formatLogDetail(detail));
}

export function logError(message: string, detail?: unknown): void {
  write('error', message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  write('warn', message, detail);
}

/** 显式记一条信息级日志。**不走 console** —— 它不是调试输出，是要留档的事件。 */
export function logInfo(message: string, detail?: unknown): void {
  send('info', message, formatLogDetail(detail));
}

/** 显式记一条调试级日志。默认级别下主进程会丢掉它，排查时把级别调到「调试」即可。 */
export function logDebug(message: string, detail?: unknown): void {
  send('debug', message, formatLogDetail(detail));
}

/**
 * 把 `console.error(...)` 的实参列表压成「一句话 + 一段附加信息」。
 *
 * 第一个字符串实参当消息，其余的全部当附加信息 —— 这与现有调用点的写法一致
 * （`console.error('Save failed:', err)`）。第一个实参不是字符串时（少见）也照收，
 * 由 `formatLogDetail` 转成文本。
 */
function forward(level: LogLevel, args: unknown[]): void {
  if (args.length === 0) return;

  const [first, ...rest] = args;
  const message = typeof first === 'string' ? first : (formatLogDetail(first) ?? '(空)');
  const detail = rest
    .map((value) => formatLogDetail(value))
    .filter((text): text is string => text !== undefined)
    .join(' | ');

  send(level, message, detail === '' ? undefined : detail);
}

/**
 * 装上接管与兜底。**在 `main.tsx` 里显式调用**，不做模块级副作用 ——
 * 「什么时候开始记日志」是这条链路正确性的一部分，不该藏在一个 import 里
 * （同 `startHostSettingsSync` 的理由）。
 *
 * 重复调用是幂等的：三个窗口跑同一份入口，但一个窗口只装一次。
 */
export function installRendererLogging(): void {
  if (installed) return;
  installed = true;

  console.error = (...args: unknown[]) => {
    rawConsole.error(...args);
    forward('error', args);
  };
  console.warn = (...args: unknown[]) => {
    rawConsole.warn(...args);
    forward('warn', args);
  };

  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}

/** 未捕获的异常：白屏最常见的原因（渲染阶段抛错时 React 边界之外还有一层）。 */
function onWindowError(event: Event): void {
  const { error, message } = event as ErrorEvent;
  // 资源加载失败（`<img>` / `<script>` 没拿到）也走这个事件，但那时 `error` 与
  // `message` 都是空的 —— 那些不是 JS 异常，记下来只会把真正的崩溃淹掉。
  if (!error && !message) return;
  logError('[Nexus Renderer] 未捕获的异常', error ?? message);
}

/** 没接住的 Promise 拒绝：`await window.nexus.xxx()` 少写一个 catch 就会走到这里。 */
function onUnhandledRejection(event: Event): void {
  logError('[Nexus Renderer] 未处理的 Promise 拒绝', (event as PromiseRejectionEvent).reason);
}

/**
 * 摘掉接管与兜底，把 `console` 还给原生那两个。
 *
 * 只给用例用：`installed` 是模块级的，而 `console` 是**全局对象上的**——一个用例装过之后
 * 后面每一个用例都在被接管的 console 里跑，断言会莫名其妙地串味。同 `resetHostSettings`。
 */
export function resetRendererLogging(): void {
  if (!installed) return;
  installed = false;
  console.error = rawConsole.error;
  console.warn = rawConsole.warn;
  window.removeEventListener('error', onWindowError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
}
