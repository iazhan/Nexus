import fs from 'node:fs';
import type { DiagnosticsIndexFile, DiagnosticsReport } from '../ipc/channels.js';

/**
 * 诊断信息：用户报问题时能贴出来的一段事实。
 *
 * ## 为什么是「结构化数据」而不是「一段文本」
 *
 * 主进程只负责**收集事实**，拼成文本是渲染进程的事（`renderer/src/settings/diagnostics.ts`）。
 * 分开的理由是**可测**：这一半要摸文件系统，那一半是纯字符串变换。合在一起就只能靠真机跑。
 *
 * ## 为什么这个模块不 import electron
 *
 * 与 `index-path.ts` / `recent-workspace.ts` 同一条纪律：纯函数（几个字符串进、一个对象出）
 * 埋在会 `import electron` 的模块里，就只有真机跑得出来。所以事实由 `electron/index.ts` 收集
 * （那里是 `app.getVersion()` 与 `process.versions` 唯一的出现处），这里只做拼装与摸盘。
 *
 * ## 刻意**不**包含的东西
 *
 * - **文档内容**：诊断信息是给外人看的（贴进 issue），里面只能有「环境」不能有「作品」。
 *   蓝图 §14.3 那条「日志不得包含文档全文、访问令牌或个人敏感内容」是同一件事。
 * - **索引的文档数**：拿它要**打开**索引库，而打开会创建库文件（`better-sqlite3` 的
 *   `new Database(path)` 会建文件）。设置页里看一眼诊断就凭空多出一个库文件，
 *   是那种「不报错但说不通」的副作用。文档数在侧栏本来就看得到，不是排障信息。
 * - **本机路径之外的一切**：`workspaceRoot` 与索引库路径含用户名，但它们是**复现问题必需的**，
 *   所以留着 —— 而设置项的描述文案必须把这件事说清楚，让用户贴之前知道自己贴了什么。
 */

/** 收集到的事实。由 `electron/index.ts` 填 —— 它知道 `app` 与 `process`。 */
export interface DiagnosticsFacts {
  version: string;
  /** `process.platform`。与 `arch` 拼成 `win32-x64` 这种形状。 */
  platform: string;
  /** `process.arch`。 */
  arch: string;
  electron: string;
  chromium: string;
  node: string;
  /** 已授权的工作区根。轻量模式（只打开一个文件）下是 `null`。 */
  workspaceRoot: string | null;
  /** 该工作区的索引库文件路径。没有工作区时是 `null`。 */
  indexDbPath: string | null;
}

export function buildDiagnostics(facts: DiagnosticsFacts): DiagnosticsReport {
  return {
    version: facts.version,
    platform: `${facts.platform}-${facts.arch}`,
    electron: facts.electron,
    chromium: facts.chromium,
    node: facts.node,
    workspaceRoot: facts.workspaceRoot,
    index: facts.indexDbPath ? describeIndexFile(facts.indexDbPath) : null
  };
}

/**
 * 索引库文件的**文件系统事实**。
 *
 * 文件还不存在（这个工作区还没建过索引）是**正常状态**，不是错误 —— 所以路径照样给出去，
 * 只把大小与时间置空。这与 `getIndexPath` 的取舍一致：路径是工作区路径的纯函数，
 * 值不依赖文件在不在。
 */
function describeIndexFile(dbPath: string): DiagnosticsIndexFile {
  try {
    const stats = fs.statSync(dbPath);
    return { path: dbPath, sizeBytes: stats.size, updatedAt: stats.mtime.toISOString() };
  } catch {
    return { path: dbPath, sizeBytes: null, updatedAt: null };
  }
}
