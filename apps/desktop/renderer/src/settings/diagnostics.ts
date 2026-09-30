import type { DiagnosticsReport } from '../../../ipc/channels.js';

/**
 * 把主进程给的诊断事实拼成**一段可以整段贴出去的文本**。
 *
 * ## 为什么标签是英文的、而且不带 i18n
 *
 * 这一段的读者有两个：用户（贴进 issue）和维护者（照着它复现）。第二种读者决定了两件事：
 *
 * 1. **键名固定**，不随界面语言变 —— 中文界面里贴出 `version: 0.44.0`、英文界面里
 *    贴出同一行，两份报告可以直接 diff。
 * 2. **`FieldDef.readonlyValue` 拿不到 `t`**（它是个无参的异步取数函数）。想本地化就得
 *    给框架件加一个参数，而那会为了「八行文字」把只读值的契约变复杂。
 *
 * 值本身（路径、版本号）本来就是语言无关的，所以这里不本地化不损失任何信息。
 *
 * ## 为什么没有「生成时间」
 *
 * 有它就得有个时间源，而**同一份报告要能被算两遍得到同一个结果** —— 显示的那一段与
 * 复制出来的那一段是两次独立的取数（`readonlyValue` 挂载时取一次，按钮点击时再取一次），
 * 加了时间戳两者就永远不相等。而「什么时候报的」在 issue 里有时间戳，不需要这里再记一遍。
 */

/** 人类可读的文件大小。`null` 由调用方处理（那是「文件不存在」，不是「0 字节」）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * 拼装。
 *
 * 缺项**整行不画**，而不是画 `workspace: (none)`：
 * 「没有工作区」与「工作区是空的」在这份文本里是两件事，而一个不存在的字段只会让人以为
 * 取数失败了。这与 `readonlyValue` 那条「取不到就不画那一行」是同一条纪律。
 */
export function formatDiagnostics(report: DiagnosticsReport): string {
  const lines = [
    `version: ${report.version}`,
    `platform: ${report.platform}`,
    `electron: ${report.electron}`,
    `chromium: ${report.chromium}`,
    `node: ${report.node}`
  ];

  if (report.workspaceRoot) lines.push(`workspace: ${report.workspaceRoot}`);

  if (report.index) {
    lines.push(`index path: ${report.index.path}`);
    // 大小与时间是**文件系统事实**：文件还没建时两者都是 null，那是正常状态。
    if (report.index.sizeBytes !== null) {
      lines.push(`index size: ${formatBytes(report.index.sizeBytes)} (${report.index.sizeBytes} bytes)`);
    }
    if (report.index.updatedAt !== null) {
      lines.push(`index updated: ${report.index.updatedAt}`);
    }
  }

  return lines.join('\n');
}

/**
 * 取一次并拼好。
 *
 * **显示与复制共用它**，所以两处拿到的是同一份文本 —— 判据是「复制出去的就是屏幕上那一段」，
 * 而不是「两处各自算了一遍、看起来差不多」。
 *
 * 桥不在（或在别的窗口形态下没透出这条通道）时返回 `null`，由调用方决定不画那一行。
 */
export async function readDiagnosticsText(): Promise<string | null> {
  const report = await window.nexus?.getDiagnostics();
  return report ? formatDiagnostics(report) : null;
}
