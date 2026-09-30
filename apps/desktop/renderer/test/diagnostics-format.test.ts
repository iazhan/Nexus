// @vitest-environment node

/**
 * 诊断信息的**文本形状**（`renderer/src/settings/diagnostics.ts`）。
 *
 * 这一层是纯函数，但它是这一项里唯一「用户真的会看到」的东西：主进程给的是对象，
 * 贴进 issue 的是这段文本。所以判据取**精确的整段字符串**而不是 `toContain` ——
 * 后者对「多了一行」「顺序变了」都无感，而这份文本的价值恰恰在于两份报告可以逐行 diff。
 */

import { describe, expect, it } from 'vitest';
import { formatBytes, formatDiagnostics } from '../src/settings/diagnostics.js';
import type { DiagnosticsReport } from '../../ipc/channels.js';

const FULL: DiagnosticsReport = {
  version: '0.44.0',
  platform: 'win32-x64',
  electron: '34.0.0',
  chromium: '132.0.6834.83',
  node: '20.18.0',
  workspaceRoot: 'E:\\notes',
  index: {
    path: 'C:\\Users\\tester\\AppData\\Roaming\\@nexus\\desktop\\workspace-index\\9473eb44a1c2b3d4.db',
    sizeBytes: 2412544,
    updatedAt: '2026-10-01T06:12:33.123Z'
  }
};

describe('文件大小', () => {
  it('不足 1 KB 时按字节给，不带小数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('从 1 KB 起进位，保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2412544)).toBe('2.3 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  /** 输入坏了要**说出来**而不是抛 —— 这一行只是显示，不该让整个设置页崩掉。 */
  it('负数与非有限值原样转成字符串', () => {
    expect(formatBytes(-1)).toBe('-1');
    expect(formatBytes(Number.NaN)).toBe('NaN');
  });
});

describe('诊断文本', () => {
  it('逐行拼接，顺序固定 —— 两份报告要能直接 diff', () => {
    expect(formatDiagnostics(FULL)).toBe(
      [
        'version: 0.44.0',
        'platform: win32-x64',
        'electron: 34.0.0',
        'chromium: 132.0.6834.83',
        'node: 20.18.0',
        'workspace: E:\\notes',
        'index path: C:\\Users\\tester\\AppData\\Roaming\\@nexus\\desktop\\workspace-index\\9473eb44a1c2b3d4.db',
        'index size: 2.3 MB (2412544 bytes)',
        'index updated: 2026-10-01T06:12:33.123Z'
      ].join('\n')
    );
  });

  /**
   * 轻量模式（只打开一个文件）下没有工作区。**前五行照给** —— 版本与平台照样是排障必需的，
   * 所以这一项没有 `probe`、按钮不禁用。缺的是工作区与索引那四行，而不是整段。
   */
  it('没有工作区时少画工作区与索引那几行，前五行照给', () => {
    const text = formatDiagnostics({ ...FULL, workspaceRoot: null, index: null });

    expect(text.split('\n')).toEqual([
      'version: 0.44.0',
      'platform: win32-x64',
      'electron: 34.0.0',
      'chromium: 132.0.6834.83',
      'node: 20.18.0'
    ]);
    expect(text).not.toContain('workspace');
    expect(text).not.toContain('index');
  });

  /** 库文件还没建：路径照给（那是「将来会建在这里」），大小与时间两行不画。 */
  it('库文件不存在时保留路径行，去掉大小与时间两行', () => {
    const text = formatDiagnostics({
      ...FULL,
      index: { path: FULL.index!.path, sizeBytes: null, updatedAt: null }
    });

    expect(text).toContain(`index path: ${FULL.index!.path}`);
    expect(text).not.toContain('index size');
    expect(text).not.toContain('index updated');
  });

  /**
   * **不含文档内容**。这一条看着像废话，但它是这份文本能不能被允许「一键复制到剪贴板」的前提 ——
   * 蓝图 §14.3 那句「日志不得包含文档全文、访问令牌或个人敏感内容」是同一件事。
   *
   * 判据取「行数固定 + 每行都是 `键: 值`」而不是逐行 `toContain`：后者对「多贴进来一段」
   * 无感，而多出来的那一段正是这里要防的。
   */
  it('每一行都是 `键: 值`，行数固定 —— 没有任何文档正文混进来', () => {
    const lines = formatDiagnostics(FULL).split('\n');

    expect(lines).toHaveLength(9);
    for (const line of lines) {
      expect(line).toMatch(/^[a-z]+( [a-z]+)*: \S/);
    }
  });
});
