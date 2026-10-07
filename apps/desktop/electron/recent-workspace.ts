/**
 * 「最近打开的工作区」的落盘、启动回落，以及菜单要用的那一列。
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
 * ## 存的是**一列**，不是单个根
 *
 * 它有两个消费者，而且问的不是同一件事：
 *   - 启动回落问「上次那个还在吗」—— 只用得上第一个；
 *   - 「文件 → 打开最近的工作区」问「我最近都开过哪些」—— 要用整列。
 *
 * 两者放同一个文件而不是各存一份：它们描述的是同一件事实（用户开过哪些目录）。
 * 拆成两个文件就会出现「回落目标指向一个菜单里没有的目录」这种自相矛盾的状态，
 * 而两份快照的写入时机不同，那种状态迟早会出现。
 *
 * ## 目录由调用方给，本模块不 import electron
 *
 * `read` / `write` 收的是**目录**而不是自己去问 `app.getPath('userData')`。
 * 这样整个模块不依赖 Electron，`recent-workspace.test.ts` 拿一个临时目录就能测全部行为
 * （含坏文件方向），不必启动一个真窗口。主进程那边只负责把 `app.getPath('userData')` 传进来。
 *
 * ## 失败方向：目录那一半一律**不恢复**
 *
 * 恢复一个工作区等于对那个目录做 `authorizeWorkspace` —— 那是一张**写权限**。
 * 所以文件缺失、读不动、JSON 坏、目录字段类型不对、目录已经不在了，五种情形全都回落成
 * 「不恢复」，而不是「尽力猜一个」。一个被改坏（或手工编辑错）的文件不该把用户送进
 * 某个任意目录，也不该让应用启动失败。
 *
 * 「要不要恢复」那个开关本身则是**回落到这一项的默认值（开）**，与设置存档同一条判据 ——
 * 它单独为真没有任何后果（列表为空时 `applyRecentWorkspace` 直接返回），
 * 而做成「认不出就当关」会让「文件少了一个字段」表现成「功能静默失效」。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LaunchContext } from '@nexus/core';
import { workspaceKey } from './index-path.js';
import { logWarn } from './logger.js';

/** 文件名。放 `userData` 根下而不是子目录：它只有一个，不值得为它建一层。 */
export const RECENT_WORKSPACE_FILE = 'recent-workspace.json';

/**
 * 列表上限，超出后最旧的那个被挤掉。
 *
 * 取 8 的理由是**显示**而不是存储：这一列直接变成菜单里的一层子项，再多就放不下了
 * （一层下拉放十几个条目只能靠滚动），而少于 5 又在「同时开着好几个知识库」的人那里不够用。
 */
export const RECENT_WORKSPACE_LIMIT = 8;

export interface RecentWorkspaceState {
  /**
   * 用户是否要求「启动时恢复上次工作区」。
   *
   * 名字与设置项一致，但**来源不同**：设置项的权威在渲染进程的存档里，这里是它的快照。
   * 缺文件时的默认值与设置项的默认值一致（都是「恢复」）—— 两种情形问的是同一个问题
   * 「用户没表达过偏好时该怎么做」，给出两个答案会让启动行为取决于一件偶然的事
   * （快照文件在不在）。
   */
  restoreLastWorkspace: boolean;
  /**
   * 最近打开过的工作区根目录，**最近的在前**。空数组 ＝ 还没打开过任何工作区。
   *
   * 只读是刻意的：`EMPTY_RECENT_WORKSPACE` 是个冻结的单例，而读取方拿到的都是
   * `{ ...EMPTY_RECENT_WORKSPACE }` 这种浅拷贝 —— **数组是共享的那一个**。可变的话，
   * 任何一次 `push` 都会污染此后所有「什么都没记过」的结果，而症状（第一次启动就带着
   * 一个谁都没打开过的目录）离原因很远。
   */
  readonly workspaceRoots: readonly string[];
}

/** 空列表的单例，冻结。见 `RecentWorkspaceState.workspaceRoots` 的只读理由。 */
const NO_WORKSPACES: readonly string[] = Object.freeze([]);

/**
 * 「什么都没记过」。缺文件、`JSON` 读不动时回落到它。
 *
 * 这里 `restoreLastWorkspace` 取 `true` 是安全的：上面两种情形下目录列必定是空的，
 * 而 `applyRecentWorkspace` 在列表为空时直接返回 —— 所以它不会因为「默认要恢复」
 * 而被送进某个目录。
 */
export const EMPTY_RECENT_WORKSPACE: Readonly<RecentWorkspaceState> = Object.freeze({
  restoreLastWorkspace: true,
  workspaceRoots: NO_WORKSPACES
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
 */
export function parseRecentWorkspace(raw: unknown): RecentWorkspaceState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_RECENT_WORKSPACE };

  const candidate = raw as Record<string, unknown>;
  const restore = candidate.restoreLastWorkspace;

  return {
    // 认不出的值回落到**这一项的默认值**（开），与设置存档那边同一条判据：
    // 一个手改出来的 `'yes'` 不该把用户从「恢复」变成「不恢复」。开关单独为真
    // 没有任何后果 —— 列表为空时 `applyRecentWorkspace` 直接返回。
    restoreLastWorkspace: restore !== false,
    workspaceRoots: readRootList(candidate)
  };
}

/**
 * 从一份已经 parse 过的对象里取出目录列。
 *
 * **旧文件兼容在这里**：这个文件原本只记一个根（`workspaceRoot: string | null`），
 * 已经装过的机器上就是那个形状。不认旧字段的话，升级后第一次启动会以为「从没打开过
 * 工作区」—— 菜单空了、启动回落也没了，而用户什么都没做错。
 *
 * 两个字段都在时**新字段赢**：旧字段只是历史遗留，新字段才是现在写出去的那个。
 * 让旧字段有机会覆盖新字段没有任何用例，只会让一个手改坏的文件多出一种表现。
 */
function readRootList(candidate: Record<string, unknown>): readonly string[] {
  const list = candidate.workspaceRoots;
  if (Array.isArray(list)) {
    return dedupeRoots(list.filter(isUsableRoot));
  }

  const legacy = candidate.workspaceRoot;
  return isUsableRoot(legacy) ? [legacy] : [];
}

/**
 * 一个值算不算一个可用的根 ＝ 非空字符串。
 *
 * 空串与纯空白按「没记过」处理（`workspaceRoot: ''` 与 `null` 等价），而不是当成一个路径 ——
 * 空路径 `fs.statSync('')` 的行为在各平台上不一致。
 */
function isUsableRoot(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 去重并截到上限。**比较用 `workspaceKey`**（`path.resolve` + Windows 折叠大小写）。
 *
 * 同一个目录在这个应用里有多种字符串写法（`D:\vault` / `d:\vault` / 末尾多个反斜杠），
 * 按原文比会让它在列表里出现两次 —— 两个菜单项指向同一个目录，点哪个都一样。
 * 这与索引库、账本用的是同一个口径（`index-path.ts` 的 `workspaceKey`），
 * 所以直接复用它而不是再写第四份。
 *
 * 保留**先出现的那个写法**，不归一化：菜单里要显示用户认得出的那条路径，
 * 而不是 `c:\users\...` 这种比较键。
 */
function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const root of roots) {
    const key = workspaceKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(root);
    if (kept.length >= RECENT_WORKSPACE_LIMIT) break;
  }

  return kept;
}

/**
 * 记一个工作区。**纯函数**，什么时候写盘由调用方决定。
 *
 * 已经在列表里的会被**提到最前**，而不是留在原位 —— 这一列的顺序就是「最近用过的顺序」，
 * 而它正是菜单的显示顺序。保留原有的字符串写法，只换位置（见 `dedupeRoots`）。
 */
export function recordRecentWorkspace(
  state: RecentWorkspaceState,
  root: string
): RecentWorkspaceState {
  if (!isUsableRoot(root)) return state;

  const key = workspaceKey(root);
  const existing = state.workspaceRoots.find((candidate) => workspaceKey(candidate) === key);

  return {
    ...state,
    workspaceRoots: [
      existing ?? root,
      ...state.workspaceRoots.filter((candidate) => workspaceKey(candidate) !== key)
    ].slice(0, RECENT_WORKSPACE_LIMIT)
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
    logWarn('[Nexus Shell] 记录最近工作区失败:', error);
  }
}

/**
 * 列出现在**还在**的最近工作区，最近的在前。给菜单用。
 *
 * 不存在的目录**直接剔除**，而不是交给界面去标灰或让点了报错：`authorizeWorkspace`
 * 不 stat 目录（它只往允许根集合里加一个字符串），所以打开一个已经不在的路径**不会失败** ——
 * 它会成功切进一个空工作区，文件树全空、索引查不到东西，用户看到的是「打开了一个工作区，
 * 但它是空的」。与其让界面有能力产生这种状态，不如在这里筛掉。
 *
 * 代价是「插着移动硬盘时开过的库，拔掉之后菜单里看不到」—— 这是刻意的取舍：
 * 菜单里少一项（用户还能走「打开文件夹…」）比多一项点了出怪状态要好。
 */
export function listRecentWorkspaces(
  state: RecentWorkspaceState,
  isDirectory: (targetPath: string) => boolean
): string[] {
  return state.workspaceRoots.filter((root) => isDirectory(root));
}

/**
 * 启动回落：没有显式路径时，按设置把上次的工作区接回来。
 *
 * `isDirectory` 由调用方注入（主进程传 `classifyLaunchPath(x) === 'directory'`），
 * 本函数因此不碰文件系统、在单测里是纯函数 —— 与 `parseLaunchArgs` 同一个做法。
 *
 * 三个前提缺一不可：**设置开着**、**记过目录**、**其中至少一个现在还在**。
 * 显式路径（命令行参数或 `NEXUS_WORKSPACE`）永远优先：用户这一次说了要开什么，
 * 就不该被上一次的记忆盖掉。
 *
 * **从头往下取第一个还存在的**，不是「只看第一个」。上次的工作区在移动硬盘或网络盘上是常态，
 * 而盘没插的时候只认第一个，结果就是「每次启动都进欢迎态」—— 用户读到的信息是
 * 「记住上次工作区这个功能坏了」，而不是「那个盘不在」。候选全部来自用户自己打开过的目录，
 * 所以往下走不存在「把用户送进一个他没见过的目录」。
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
  // 裸启动的判据是**三个字段一起**：工作区模式、还没定目录、也没有一个打不开的路径。
  // 只看 `mode` 不够 —— `workspace` 模式本来就允许 `workspaceRoot` 为空（欢迎态），
  // 那正是本函数要处理的情形，不是要排除的情形。
  const empty =
    context.mode === 'workspace' &&
    context.workspaceRoot === null &&
    context.unsupportedPath === null;
  if (!empty) return context;
  if (!state.restoreLastWorkspace) return context;

  const root = state.workspaceRoots.find((candidate) => isDirectory(candidate));
  if (root === undefined) return context;

  return {
    mode: 'workspace',
    filePath: null,
    documentType: null,
    workspaceRoot: root,
    unsupportedPath: null
  };
}
