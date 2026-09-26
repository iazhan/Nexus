/**
 * 历史条目的时间显示。
 *
 * 存储用 UTC（见 `history-store.ts`：目录按文件名**字典序**排序，本地时间在
 * 跨时区 / 夏令时下字典序不等于时间序），但**显示必须转成本机时间** ——
 * 用户问的是「这一版什么时候保存的」，答案是他的本地时间，不是 UTC。
 *
 * 早先这里直接显示 UTC，理由是「和文件名里的时间保持一致」。那是开发者的理由：
 * 用户不会去翻 `.nexus/history/` 的文件名，他看界面。界面显示 10:30 而实际是
 * 18:30 保存的，只会让人以为历史记错了时间。
 */

/** 时间戳形状：`YYYYMMDDTHHMMSS`（UTC，无冒号 —— Windows 文件名不允许）。 */
const TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

/**
 * `20260926T103000`（UTC）→ `2026-09-26 18:30`（**本机时间**，此处为 GMT+8）。
 *
 * 无法识别的形状原样返回，不抛错 —— 面板上显示一个原始字符串，
 * 好过整块历史因为一条脏数据渲染不出来。
 */
export function formatSavedAt(savedAt: string): string {
  const match = TIMESTAMP_PATTERN.exec(savedAt);
  if (!match) return savedAt;

  // 按 UTC 构造出同一时刻，再读**本地**字段 —— 这样在任何时区都显示成
  // 用户所在时区的时间。用 getUTC* 会退回 UTC 显示（就是这个 bug）。
  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    )
  );

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
