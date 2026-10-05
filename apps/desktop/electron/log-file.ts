/**
 * 日志落盘器：一条日志怎么变成磁盘上的一行。
 *
 * ## 为什么单独一个模块、且不 import electron
 *
 * 与 `index-path.ts` / `recent-workspace.ts` / `diagnostics.ts` 同一条纪律：这里全是
 * **纯函数加文件系统调用**（时间戳、单行组装、轮转），埋在会 `import electron` 的入口里
 * 就只有真机跑得出来。收一个目录字符串，`log-file.test.ts` 就能拿一个临时目录跑完轮转。
 *
 * ## 为什么是同步写
 *
 * `fs.appendFileSync` 而不是 `createWriteStream`。理由不是「简单」，是**退出时不能丢**：
 * 最后几条日志往往正是崩溃现场（`uncaughtException` 之后进程就要退了），而流式写入
 * `end()` 之后数据还在用户态缓冲区里，进程一退就没了。同步写在 `appendFileSync` 返回时
 * 已经交给操作系统，不需要 flush 协议，也不需要「关闭日志」这一步。
 *
 * 代价是每条日志一次 open/write/close。这是**有意的取舍**：进日志的应当是「用户级事件」
 * （打开失败、索引重建、更新检查），每秒几条都算多；而高频路径（每次按键、每页渲染）
 * 本来就不该写日志。若哪天要在高频路径上记东西，先在调用方聚合，别改成异步流。
 *
 * ## 写盘失败只降级一次
 *
 * 目录不可写（权限、磁盘满、路径是个文件）时第一次就置 `broken`，之后连 `try` 都不再进。
 * 一个坏掉的日志目录不该让每次 `logWarn` 都去摸一次盘 —— 那会把「日志坏了」放大成
 * 「应用卡了」。`onError` 只报第一次，由调用方决定怎么让人知道（一般是往控制台喊一声）。
 *
 * ## 轮转按大小，不按时间
 *
 * 按天切需要定时器（还有一个「跨零点时那个定时器还在不在」的问题），而日志量本来就不可预测 ——
 * 空闲一天写不了几行，出错一分钟能刷满。大小阈值是**唯一一个不需要调度器**的判据：
 * 每次写入前看一眼累计字节，超了就换文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import type { LogLevel } from '@nexus/core';

/** 日志目录名。`<userData>/logs/`，设置页的「打开日志目录」打开的就是它。 */
export const LOG_DIR_NAME = 'logs';

/** 当前日志文件名。轮转出来的历史文件是 `nexus.1.log` / `nexus.2.log` / … */
export const LOG_FILE_NAME = 'nexus.log';

/**
 * 单个文件的上限。**5 MB 而不是 1 MB**：一条带堆栈的错误大约 1–3 KB，5 MB 装得下
 * 上千条；而上限太小会让「用户刚复现完问题、日志已经轮转掉了」变成常态。
 */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 保留几份轮转文件（不含当前这份）。**3 份 = 最多 20 MB**。
 * 再多只是让用户更不敢删，而不是让排障更容易 —— 真要看那么久以前的日志，
 * 该做的是早点来报问题。
 */
export const LOG_FILE_KEEP = 3;

/** 日志目录的绝对路径。`userData` 的取值只在主进程那边，这里收一个目录字符串。 */
export function logsDirectoryFor(userDataDir: string): string {
  return path.join(userDataDir, LOG_DIR_NAME);
}

/**
 * 当前日志文件的绝对路径。
 *
 * 单独一个函数而不是把 `path.join` 散在几处：设置页那个只读值、打开目录、
 * 真正的写入三处必须落在同一个文件上 —— 拼错一处时「显示的位置」与「实际写的位置」
 * 会静默分家（`index-path.ts` 那条纪律的同一件事）。
 */
export function logFilePath(directory: string): string {
  return path.join(directory, LOG_FILE_NAME);
}

/** 第 `index` 份轮转文件的路径。`index` 从 1 开始（1 是最新的那份历史）。 */
export function rotatedLogPath(directory: string, index: number): string {
  const parsed = path.parse(LOG_FILE_NAME);
  return path.join(directory, `${parsed.name}.${index}${parsed.ext}`);
}

/**
 * 时间戳：`2026-10-05 23:40:12.345 +08:00`。
 *
 * 用**本地时间加偏移量**而不是 `toISOString()` 的 UTC：这份文件的第一读者是遇到问题的用户
 * 和照着复现的维护者，两边通常都在同一台机器上 —— 本地时间才是他们对照「我几点点的」时
 * 不用换算的那个。带上偏移量是为了跨时区转发时不产生歧义（只写本地时间的话，
 * 一份贴到 issue 里的日志没法判断是哪个时区）。
 */
export function formatTimestamp(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);

  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)} ` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * 附加信息压成**单行**。
 *
 * 换行必须转义：一条日志占一行，是 `grep`、`tail`、以及任何按行读的工具能工作的前提。
 * 堆栈挤成一行会难读一点，但「读得费劲」远好过「把后面几十行日志吃掉」——
 * 后者会让整份文件从崩溃点开始全是垃圾。
 */
function describeDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;

  let text: string;
  try {
    // `inspect` 而不是 `JSON.stringify`：日志里出现的常常是 Error、Map、循环引用，
    // 而 `JSON.stringify(new Error('x'))` 得到的是 `{}` —— 最该记下来的那种东西反而没了。
    text = inspect(detail, { depth: 4, breakLength: Infinity });
  } catch {
    // `inspect` 自己抛的情况（自定义 inspect 出问题）不该让日志这一行消失。
    text = '<无法描述的值>';
  }

  const single = text.replace(/\r?\n/g, '\\n').trim();
  return single === '' ? null : single;
}

export interface LogLineInput {
  at: Date;
  level: LogLevel;
  message: string;
  detail?: unknown;
}

/** 组装一行。**不含换行符** —— 加换行是写入方的事。 */
export function formatLogLine(input: LogLineInput): string {
  const head = `${formatTimestamp(input.at)} [${input.level}] ${input.message}`;
  const detail = describeDetail(input.detail);
  return detail === null ? head : `${head} | ${detail}`;
}

export interface LogFileSink {
  /** 日志目录（`openLogsDirectory` 打开的那个）。 */
  readonly directory: string;
  /** 当前日志文件的绝对路径。 */
  readonly filePath: string;
  /** 写盘已经失败过。调用方据此停止指望这份文件。 */
  readonly broken: boolean;
  /** 写一行。返回 `false` ＝ 这次没写进去（并已置 `broken`）。 */
  write(line: string): boolean;
}

export interface LogFileSinkOptions {
  directory: string;
  maxBytes?: number;
  keep?: number;
  /** 第一次写失败时叫一次。之后不再叫 —— 见文件头「只降级一次」。 */
  onError?: (error: unknown) => void;
}

function fileSizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    // 文件还不存在是这个模块的**正常**起点（首次运行），不是错误。
    return 0;
  }
}

/**
 * 把 `nexus.log` 挪成 `nexus.1.log`，依次后推，最老的那份删掉。
 *
 * 顺序不能反：**先删最老的，再从后往前重命名**。反过来（从 `nexus.1.log` 开始往后推）
 * 会把还没搬走的文件覆盖掉 —— 症状是历史日志少一份，且没有任何报错。
 *
 * 整段不抛：轮转失败（文件被占用）只意味着这次换不了文件，日志本身照写不误。
 */
function rotate(filePath: string, directory: string, keep: number): void {
  try {
    fs.rmSync(rotatedLogPath(directory, keep), { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(directory, index);
      if (fs.existsSync(from)) fs.renameSync(from, rotatedLogPath(directory, index + 1));
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, rotatedLogPath(directory, 1));
  } catch {
    // 轮转是整理，不是写入的前提。失败了就继续往当前文件追加。
  }
}

export function createLogFileSink(options: LogFileSinkOptions): LogFileSink {
  const directory = options.directory;
  const filePath = logFilePath(directory);
  const maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
  const keep = options.keep ?? LOG_FILE_KEEP;

  let broken = false;
  let directoryReady = false;
  let bytesWritten = fileSizeOf(filePath);

  const sink: LogFileSink = {
    directory,
    filePath,
    get broken() {
      return broken;
    },
    write(line: string): boolean {
      if (broken) return false;

      try {
        if (!directoryReady) {
          fs.mkdirSync(directory, { recursive: true });
          directoryReady = true;
        }

        const size = Buffer.byteLength(line, 'utf8') + 1;
        // `bytesWritten > 0` 那一半是防止「单行超过上限」时每次写都轮转一次 ——
        // 那种情况下阈值永远满足，文件会被反复清空，日志反而全丢。
        if (bytesWritten > 0 && bytesWritten + size > maxBytes) {
          rotate(filePath, directory, keep);
          bytesWritten = 0;
        }

        fs.appendFileSync(filePath, `${line}\n`);
        bytesWritten += size;
        return true;
      } catch (error) {
        broken = true;
        options.onError?.(error);
        return false;
      }
    }
  };

  return sink;
}
