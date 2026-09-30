/**
 * 「上次打开的工作区」的落盘与启动回落。
 *
 * ## 为什么必须落盘，而宿主设置通道那一份不落盘
 *
 * `host-settings.ts` 明说了「内存而不是落盘」，理由是渲染进程启动时就会送一次，
 * 主进程不需要自己持久化。**这一项是那条理由唯一的例外**：它要决定的是
 * 「这次启动进哪个模式」，而 `launchContext` 在主进程**模块加载时**就求值了 ——
 * 那一刻还没有任何渲染进程，送不过来。
 *
 * 所以这里的文件不是「第二个事实源」，而是一份**给下一次启动读的快照**：
 * 真正的「用户选了什么」住在渲染进程的存档里（`general.restoreLastWorkspace`），
 * 主进程只是把它连同自己知道的那个目录一起记下来。
 *
 * ## 目录由调用方给，本模块不 import electron
 *
 * `read` / `write` 收的是**目录**而不是自己去问 `app.getPath('userData')`。
 * 这样整个模块不依赖 Electron，`recent-workspace.test.ts` 拿一个临时目录就能测全部行为
 * （含坏文件方向），不必启动一个真窗口。主进程那边只负责把 `app.getPath('userData')` 传进来。
 *
 * ## 失败方向：一律**不恢复**
 *
 * 恢复一个工作区等于对那个目录做 `authorizeWorkspace` —— 那是一张**写权限**。
 * 所以文件缺失、读不动、JSON 坏、字段类型不对、目录已经不在了，五种情形全都回落成
 * 「不恢复」，而不是「尽力猜一个」。一个被改坏（或手工编辑错）的文件不该把用户送进
 * 某个任意目录，也不该让应用启动失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LaunchContext } from '@nexus/core';

/** 文件名。放 `userData` 根下而不是子目录：它只有一个，不值得为它建一层。 */
export const RECENT_WORKSPACE_FILE = 'recent-workspace.json';

export interface RecentWorkspaceState {
  /**
   * 用户是否要求「启动时恢复上次工作区」。
   *
   * 名字与设置项一致，但**来源不同**：设置项的权威在渲染进程的存档里，这里是它的快照。
   * 默认 `false` ＝ 与加这一项之前完全一致的启动行为。
   */
  restoreLastWorkspace: boolean;
  /** 上一次进入工作区模式时的根目录。`null` ＝ 还没打开过任何工作区。 */
  workspaceRoot: string | null;
}

/** 「什么都没记过」。缺文件、读坏了、类型不对，都回落到它。 */
export const EMPTY_RECENT_WORKSPACE: Readonly<RecentWorkspaceState> = Object.freeze({
  restoreLastWorkspace: false,
  workspaceRoot: null
});

export function recentWorkspacePath(directory: string): string {
  return path.join(directory, RECENT_WORKSPACE_FILE);
}

/**
 * 读一份。**任何异常都回落到空状态**，包括 `JSON.parse` 抛与字段类型不对。
 *
 * 不区分「文件不存在」与「文件坏了」：两种情形的正确反应相同（不恢复），
 * 分开只会多一条没人看的日志分支。
 */
export function readRecentWorkspace(directory: string): RecentWorkspaceState {
  let raw: string;
  try {
    raw = fs.readFileSync(recentWorkspacePath(directory), 'utf8');
  } catch {
    return { ...EMPTY_RECENT_WORKSPACE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_RECENT_WORKSPACE };
  }

  return parseRecentWorkspace(parsed);
}

/**
 * 校验一份已经 `JSON.parse` 过的东西。**逐个字段判，不整体信任** ——
 * 这是磁盘上的文件，用户改得动，而且它最终会变成一次目录授权。
 *
 * 空串按「没记过」处理（`workspaceRoot: ''` 与 `null` 等价），而不是当成一个路径 ——
 * 空路径 `fs.statSync('')` 的行为在各平台上不一致。
 */
export function parseRecentWorkspace(raw: unknown): RecentWorkspaceState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_RECENT_WORKSPACE };

  const candidate = raw as Record<string, unknown>;
  const restore = candidate.restoreLastWorkspace;
  const root = candidate.workspaceRoot;

  return {
    restoreLastWorkspace: restore === true,
    workspaceRoot: typeof root === 'string' && root.trim() !== '' ? root : null
  };
}

/**
 * 写一份。**失败不抛** —— 记不住上次的工作区只影响下次启动的便利，
 * 不该让应用在这一刻起不来。目录不存在时先建（`userData` 正常情况下已经在了，
 * 但测试与首次运行都会遇到它还没有的情况）。
 */
export function writeRecentWorkspace(directory: string, state: RecentWorkspaceState): void {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      recentWorkspacePath(directory),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn('[Nexus Shell] 记录最近工作区失败:', error);
  }
}

/**
 * 启动回落：没有显式路径时，按设置把上次的工作区接回来。
 *
 * `isDirectory` 由调用方注入（主进程传 `classifyLaunchPath(x) === 'directory'`），
 * 本函数因此不碰文件系统、在单测里是纯函数 —— 与 `parseLaunchArgs` 同一个做法。
 *
 * 三个前提缺一不可：**设置开着**、**记过一个目录**、**那个目录现在还在**。
 * 显式路径（命令行参数或 `NEXUS_WORKSPACE`）永远优先：用户这一次说了要开什么，
 * 就不该被上一次的记忆盖掉。
 *
 * **`unsupportedPath` 也必须为空**，这一条容易漏：`parseLaunchArgs` 对「不在白名单里的
 * 文件」返回的是 `lightweight` + `filePath: null` + `unsupportedPath: <那个文件>`，
 * 与「什么都没给」只差最后一个字段。漏判的后果是**打开一个 .xyz 文件会静默变成
 * 上次的工作区**，那句「不支持的文件」提示再也不会出现。
 */
export function applyRecentWorkspace(
  context: LaunchContext,
  state: RecentWorkspaceState,
  isDirectory: (targetPath: string) => boolean
): LaunchContext {
  const empty =
    context.mode === 'lightweight' &&
    context.filePath === null &&
    context.unsupportedPath === null;
  if (!empty) return context;
  if (!state.restoreLastWorkspace) return context;

  const root = state.workspaceRoot;
  if (root === null || !isDirectory(root)) return context;

  return {
    mode: 'workspace',
    filePath: null,
    documentType: null,
    workspaceRoot: root,
    unsupportedPath: null
  };
}
