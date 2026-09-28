/**
 * 时间显示格式化 —— renderer 里**唯一**回答「这个时间怎么显示」的模块。
 *
 * 之所以收成一个模块：两个函数共享同一个输出形状（`YYYY-MM-DD HH:MM`，本机时间），
 * 而这个形状一旦分裂成两处实现，改一处忘一处不会报错 —— 只会让界面上两种时间格式
 * 并存（P3-02 的教训：同一件事有两处判据时，改一处忘一处是静默的）。
 */

/** 时间戳形状：`YYYYMMDDTHHMMSS`（UTC，无冒号 —— Windows 文件名不允许）。 */
const TIMESTAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

/**
 * `20260926T103000`（UTC）→ `2026-09-26 18:30`（**本机时间**，此处为 GMT+8）。
 *
 * 存储用 UTC（见 `history-store.ts`：目录按文件名**字典序**排序，本地时间在
 * 跨时区 / 夏令时下字典序不等于时间序），但**显示必须转成本机时间** ——
 * 用户问的是「这一版什么时候保存的」，答案是他的本地时间，不是 UTC。
 *
 * 早先这里直接显示 UTC，理由是「和文件名里的时间保持一致」。那是开发者的理由：
 * 用户不会去翻 `.nexus/history/` 的文件名，他看界面。界面显示 10:30 而实际是
 * 18:30 保存的，只会让人以为历史记错了时间。
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

  return formatLocal(date);
}

/**
 * 毫秒时间戳 → `2026-09-26 18:30`（本机时间）。
 *
 * 用于 `stat().mtimeMs` 这类来自文件系统的时刻（附件的修改时间）。
 *
 * **`0` 与非有限数返回空串**，而不是像 `formatFileSize` 那样回一个「零值」：
 * 那里 `0 B` 是合理信息，而 `0` 毫秒会渲染成 `1970-01-01 08:00` ——
 * 一个看起来像真的、实际是「stat 失败」的假时间。空串让调用方自己决定要不要显示。
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return formatLocal(new Date(ms));
}

function formatLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
