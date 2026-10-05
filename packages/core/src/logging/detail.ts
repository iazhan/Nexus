/**
 * 把一条日志的附加信息压成**一段文本**。
 *
 * ## 为什么需要它：跨进程传不了 Error
 *
 * 渲染进程与 preload 记日志要经 IPC 把附加信息送到主进程，而 Electron 的结构化克隆
 * **不保留原型** —— 一个 `Error` 送过去就是 `{}`，最该记下来的堆栈反而没了。
 * 所以两边在送之前先把值转成字符串。
 *
 * 放在 `@nexus/core` 而不是各写一份：渲染进程、preload、以及将来的任何一侧都要用同一套
 * 转换口径，两处各写一份的症状是「同一个错误在主进程日志里带堆栈、在渲染进程日志里只有
 * 一句 `[object Object]`」，而没人会为此报 bug —— 只是排障时白费一轮。
 *
 * ## 为什么不是 `JSON.stringify` 一条路
 *
 * - `Error` 走 JSON 会变成 `{}`（可枚举属性只有自定义的那些），所以先特判。
 * - 循环引用会**抛**，而抛在这里等于丢掉整条日志 —— 退化成 `String(value)` 也比没有强。
 * - 字符串原样返回：`console.error('失败:', 'EACCES')` 不该变成 `"EACCES"`（带引号）。
 */

/** 返回 `undefined` 表示「没有附加信息可写」，由调用方决定不画那一段。 */
export function formatLogDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') return value === '' ? undefined : value;

  if (value instanceof Error) {
    // 有堆栈就用堆栈（它已经包含 `Name: message` 那一行），没有才退回那一行。
    const stack = value.stack;
    return stack && stack !== '' ? stack : `${value.name}: ${value.message}`;
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      // 循环引用、BigInt 之类。**不抛** —— 记不下来一条日志，不该比丢掉它更糟。
      return String(value);
    }
  }

  return String(value);
}
