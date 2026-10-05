/**
 * 主进程的日志门面。
 *
 * ## 为什么要有这一层，而不是各处直接 `console.*`
 *
 * 打包之后，主进程的 stdout **没有任何人看得到** —— 用户双击图标启动，控制台不存在。
 * 于是「保存失败」「索引没建起来」「更新检查出错」这些只有开发者看得见，
 * 用户报问题时手里什么都没有。这一层的唯一职责是把那些消息**留在盘上**。
 *
 * 与 `host-settings.ts` 同形：模块级的一份当前状态，谁读都是同一份。
 *
 * ## 级别是「现读」的，所以拨开关立即生效
 *
 * `initLogger` 收的是一个**取值函数**而不是一个级别值。设置住在渲染进程的存储里、
 * 经宿主设置通道送过来（`hostSettings().logLevel`），而那个值随时会变 ——
 * 把级别在 init 时定死，症状就是「在设置里调到 debug，重启才生效」。
 * 现读还有第二个好处：`logger.ts` 不必知道 `host-settings.ts` 的存在（依赖方向是反的）。
 *
 * ## init 之前先攒着
 *
 * 主进程有一批日志发生在 `app.whenReady()` 之前（启动参数解析、工作区恢复、主题目录扫描），
 * 而日志目录要等 `app.getPath('userData')` 才算得出来。这些早期日志**恰恰是排障最需要的**
 * （「为什么这次启动没进工作区」的答案就在里面），所以 init 之前先攒进 `pending`，
 * init 时按当前级别补写。上限 500 条，超了丢最老的 —— 保留最近的一段比保留开头的一段有用。
 *
 * ## 与 `console.*` 的分工
 *
 * 两条都写：控制台一份给 `pnpm dev` 的终端（开发时看得见、能立刻定位），
 * 文件一份给用户与事后排查。**不是二选一** —— 只写文件会让开发时看不到日志，
 * 只写控制台就是加这一层之前的状态。
 */

import { LOG_LEVEL_DEFAULT, logLevelAllows, type LogLevel } from '@nexus/core';
import { createLogFileSink, formatLogLine, type LogFileSink } from './log-file.js';

interface LogRecord {
  level: LogLevel;
  message: string;
  detail?: unknown;
}

/** init 之前攒下的记录。上限见文件头。 */
const PENDING_LIMIT = 500;
const pending: LogRecord[] = [];

let sink: LogFileSink | null = null;
let levelProvider: () => LogLevel = () => LOG_LEVEL_DEFAULT;

export interface LoggerInitOptions {
  /** 日志目录（`logsDirectoryFor(app.getPath('userData'))`）。 */
  directory: string;
  /** 当前级别的取值函数。**每次写日志都会调用它** —— 见文件头「现读」。 */
  level: () => LogLevel;
}

function consoleFor(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'error':
      return console.error.bind(console);
    case 'warn':
      return console.warn.bind(console);
    case 'info':
      return console.info.bind(console);
    case 'debug':
      return console.debug.bind(console);
  }
}

function emit(record: LogRecord): void {
  if (!logLevelAllows(levelProvider(), record.level)) return;

  const line = formatLogLine({
    at: new Date(),
    level: record.level,
    message: record.message,
    detail: record.detail
  });

  consoleFor(record.level)(line);
  sink?.write(line);
}

function record(level: LogLevel, message: string, detail?: unknown): void {
  const entry: LogRecord = { level, message, detail };
  if (sink === null) {
    if (pending.length >= PENDING_LIMIT) pending.shift();
    pending.push(entry);
    return;
  }
  emit(entry);
}

/**
 * 装好落盘。**在模块顶层调用一次**（早于任何可能出错的初始化），
 * 之后的 `logInfo` / `logError` 才开始往盘上写。
 *
 * 重复调用是安全的：第二次会换掉 sink 并把当前攒着的记录补写出去。
 */
export function initLogger(options: LoggerInitOptions): void {
  levelProvider = options.level;

  sink = createLogFileSink({
    directory: options.directory,
    onError: (error) => {
      // 日志自己的失败**不能走 logger**（会递归），也不该被级别滤掉：
      // 「日志没写成」是用户必须知道的事，否则他会以为盘上有东西而其实没有。
      // 这里直接落到控制台，用原始 console。
      console.error('[Nexus Shell] 日志写盘失败，本次运行不再重试:', error);
    }
  });

  for (const entry of pending.splice(0)) emit(entry);
}

/** 当前日志文件路径。日志还没 init（或已 reset）时是 `null`。 */
export function logFilePathOrNull(): string | null {
  return sink?.filePath ?? null;
}

export function logError(message: string, detail?: unknown): void {
  record('error', message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  record('warn', message, detail);
}

export function logInfo(message: string, detail?: unknown): void {
  record('info', message, detail);
}

export function logDebug(message: string, detail?: unknown): void {
  record('debug', message, detail);
}

/**
 * 回到「还没 init」的状态。测试用：`singleFork` 下模块状态跨文件共享，
 * 不还原会让一个文件的 sink 渗到后面的用例里（同 `resetHostSettings` 的理由）。
 */
export function resetLogger(): void {
  sink = null;
  levelProvider = () => LOG_LEVEL_DEFAULT;
  pending.length = 0;
}
