/**
 * 工作区索引库的落点。
 *
 * ## 为什么单独一个模块
 *
 * 它原来埋在 `electron/index.ts` 里，于是「索引落在哪」这件事只有真机跑得出来 ——
 * 而那是个**纯函数**（`sha256(规范化的工作区路径)` 取前 16 位当文件名），拿两个字符串就能测完。
 * 抽出来的直接收益是：设置页那个只读值、打开目录、真正的建库三处走的是**同一个函数**，
 * 而不是三处各拼一遍路径 —— 拼错一处时，「显示的位置」与「实际建的位置」会静默分家。
 *
 * ## 目录由调用方给，本模块不 import electron
 *
 * 与 `recent-workspace.ts` 同一条纪律：`userData` 的取值（`app.getPath('userData')`）
 * 只出现在主进程那边，这里收一个目录字符串。`index-path.test.ts` 因此不需要启动窗口。
 *
 * ## 为什么是哈希而不是可读名
 *
 * 工作区路径可能很长、可能含不能进文件名的字符（Windows 的 `:` 与保留名），
 * 而它同时是**跨平台**的 —— 同一个工作区在 Windows 与 macOS 上算出的库文件名一致，
 * 用户把整个工作区搬过去时索引能跟着走（虽然重建也不贵）。代价是文件名不可读，
 * 那一格由设置页的只读值补上。
 *
 * ## 哈希前必须先归一（第十批真机用例查出来的 bug）
 *
 * 同一个工作区在这个应用里有**不止一种字符串写法**：侧栏预热用的是启动参数里的原始路径
 * （`C:\Users\...\vault`），而设置页的动作拿的是 `getWorkspaceRoots()[0]` —— 那是
 * `FileService.toPathKey` 的比较键（Windows 上 `path.resolve` + **折叠大小写**，
 * 也就是 `c:\users\...\vault`）。直接拿这两种字符串各哈希一次，结果是**一个工作区两个库**：
 * 设置页的「重建索引」建在 `2dae34df….db`，而主窗口搜索读的是 `9473eb44….db`，
 * 两边都不报错，症状是「在设置页重建了索引，搜索结果没变」。
 *
 * 所以摘要算在 `workspaceKey()` 上，而不是原始入参上。**任何调用方传什么写法都得到同一个库**，
 * 这是「显示的位置」与「打开的位置」能不分家的前提。
 *
 * 归一的口径与 `FileService.toPathKey` 一致（`path.resolve` + Windows 折叠大小写）：
 * 两处不一致的话，索引路径的归一就成了第三套规则。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/** 库文件都落在这个子目录下。设置页的「打开索引目录」打开的就是它。 */
export const INDEX_DIR_NAME = 'workspace-index';

/**
 * 工作区路径的**规范化键**：`path.resolve` + Windows 上折叠大小写。
 *
 * 与 `FileService.toPathKey` 同一口径（那个是私有的，这里再写一遍是有意的：本模块
 * 不 import `file-service` —— 那会把它拖进 Electron 的依赖里，纯函数就没法单测了）。
 * 改动其中一个时另一个必须跟着改；`index-path.test.ts` 钉住了平台分支这一条。
 */
export function workspaceKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 工作区路径 → 库文件名里的那个摘要。**16 个 hex 字符 ＝ 64 bit**：
 * 碰撞概率在这个量级（每台机器几十个工作区）下可以忽略，而名字短一半更好看。
 */
function digestOf(rootPath: string): string {
  return createHash('sha256').update(workspaceKey(rootPath)).digest('hex').slice(0, 16);
}

/** 索引库**文件**（`.db`）的绝对路径。设置页显示的是它。 */
export function indexPathForWorkspace(userDataDir: string, rootPath: string): string {
  return path.join(userDataDir, INDEX_DIR_NAME, `${digestOf(rootPath)}.db`);
}

/**
 * 索引库**目录**的绝对路径 —— 一个工作区一个文件，所以它是所有工作区共享的那一层。
 *
 * 它由「文件路径的父目录」算出来，而不是把 `path.join` 再写一遍：两处各写一遍的话，
 * 哪天改了目录名，`openIndexDirectory` 会打开一个空目录而**不报错**。
 */
export function indexDirectoryForWorkspace(userDataDir: string, rootPath: string): string {
  return path.dirname(indexPathForWorkspace(userDataDir, rootPath));
}
