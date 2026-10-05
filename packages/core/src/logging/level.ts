/**
 * 日志级别的取值域。
 *
 * ## 为什么在 `@nexus/core` 而不是渲染进程的设置表里
 *
 * 判据与 `history/retention.ts` 同一条：**有一个渲染进程之外的函数，它的正确性依赖这个域**。
 * 这里的那个函数是主进程的 logger —— 它决定「这一条要不要写盘」，而它读的是渲染进程送过来的
 * 级别。取值域若只写在 `preference-specs.ts`，主进程就只能自己再写一份「哪几档、谁比谁严重」，
 * 而两处不一致的症状是**静默的**：设置页显示「仅错误」，主进程按 info 往盘里灌，
 * 或者反过来 —— 用户以为在收集细节，实际什么都没写。
 *
 * `@nexus/core` 是唯一一个两边都依赖、且自己没有依赖的包（`apps/desktop/electron/*`
 * 渲染进程 import 不了：那些模块顶层就 import pdfjs 与 mammoth）。
 *
 * ## 为什么是「严重程度」而不是「详细程度」
 *
 * 级别名是给人选的（error / warn / info / debug），但**比较**必须有唯一口径：
 * 一条 `warn` 日志在级别设为 `warn` 或 `debug` 时都要写。用「越靠后越啰嗦」的数组顺序
 * 来表达这件事是最省心的 —— 加一档时只要想清楚它插在哪，比较逻辑不用动。
 *
 * 注意 `debug` 是**最啰嗦**的那一档，不是「最高级」：`error` 才是任何级别下都写得进去的。
 */

/**
 * 全部级别，**从最严重到最啰嗦**。这个顺序就是严重程度本身，不要重排 ——
 * 设置页的下拉顺序、`logLevelAllows` 的比较、以及将来可能有的默认档都从这里取。
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * 默认档。
 *
 * 取 `info` 而不是更安静的 `error`：这一项的作用是**留下排障材料**，而材料缺了补不回来。
 * 默认只记 error 的话，用户遇到问题时盘上往往只有一条孤零零的报错，前因（哪次打开失败、
 * 哪次索引没建起来）全被滤掉了 —— 那正是最需要的东西。
 *
 * 与 `DEFAULT_HOST_SETTINGS.logLevel` 取同一个值是有意的：主进程在收到渲染进程那份设置之前
 * 也按 `info` 写，这样「启动到设置送达」这段窗口的日志不会因为级别不同而少一块。
 */
export const LOG_LEVEL_DEFAULT: LogLevel = 'info';

const SEVERITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

/** 是不是一个认得的级别。用于跨进程载荷的校验。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * 解析一个来路不明的值。**认不出的回落默认档**，与 `choiceSetting` 同一条判据
 * （值域是有限枚举，且这个值下游要拿去查表）。
 *
 * 与 `parseHistoryRetention` 的方向**相反**是有意的：那一项会删数据，所以未知值要往
 * 「什么都不做」那一侧倒；日志级别删不掉任何东西，认不出时按默认记就是最合理的答案。
 */
export function parseLogLevel(raw: unknown): LogLevel {
  return isLogLevel(raw) ? raw : LOG_LEVEL_DEFAULT;
}

/**
 * 当前级别下，一条该级别的日志要不要写。
 *
 * 名字刻意是 `logLevelAllows(current, message)` 而不是「比较」—— 两个参数都是级别、
 * 顺序写反了编译期看不出来，所以参数名要说清谁是门槛、谁是那一条。
 */
export function logLevelAllows(current: LogLevel, message: LogLevel): boolean {
  return SEVERITY[message] <= SEVERITY[current];
}
