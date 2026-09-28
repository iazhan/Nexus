/**
 * 字节数 → 人类可读字符串。
 *
 * ## 为什么是 1024 进制却标 `KB` / `MB`
 *
 * 严格说 1024 进制该标 `KiB` / `MiB`，但**用户看到的界面里 `KB` 就是 1024 字节** ——
 * Windows 资源管理器、macOS Finder（按十进制显示时除外）都这么用。这里跟随这个
 * 事实标准，而不是跟随 IEC 标准：文件大小是个「一眼判断要不要打开」的信息，
 * 与用户在别处看到的数字一致比单位严谨更重要。
 *
 * ## 边界
 *
 * - `0` / 负数 / `NaN` / `Infinity` 一律回 `0 B`。索引里 stat 失败时写的就是 0，
 *   而 `NaN` 会一路渲染成 `NaN B` —— 那种输出看起来像 bug，不如给个确定的零。
 * - 整数部分大于等于 1 时**去掉 `.0`**：`1024` → `1 KB` 而不是 `1.0 KB`。
 */

/** 单位表。最后一个单位是上限，再大的数会一直用它（TB 级的附件不现实）。 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 进制。见文件头对「1024 进制 + KB 标签」的说明。 */
const SIZE_STEP = 1024;

/**
 * 格式化字节数。
 *
 * 不依赖 i18n：单位符号（B/KB/MB）在中文与英文界面里是同一串字符，
 * 走 i18n 只会让调用方多传一个 `t`。数字格式同理（用 `.` 作小数点）。
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${SIZE_UNITS[0]}`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= SIZE_STEP && unitIndex < SIZE_UNITS.length - 1) {
    value /= SIZE_STEP;
    unitIndex += 1;
  }

  // 字节数不该出现小数（`512.4 B` 没有意义）；带单位的保留一位，
  // 但把整数结果的 `.0` 去掉。
  const text =
    unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');

  return `${text} ${SIZE_UNITS[unitIndex]}`;
}
