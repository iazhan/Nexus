/**
 * 主题目录在渲染进程这一侧的投影：**坏文件清单**与**写盘失败清单**。
 *
 * 两张表都是「用户看不见东西却不知道少了什么」的反面：
 *
 * - **坏文件** —— 目录里放了个手改坏的 YAML，静默跳过的话用户会以为「Nexus 不认我的文件」；
 * - **写盘失败** —— 改完主题磁盘没写进去，下次启动它就不在了，不说等于主题自己消失。
 *
 * 坏文件清单来自首帧载荷（`themeBoot.broken`），**只在下一次启动时刷新**：它描述的是「这个
 * 目录现在长什么样」，而目录只有主进程读得到（`<home>/.nexus/themes/`）。写盘失败清单是会话内
 * 的，下一次成功的同步会把它清空。
 *
 * 快照**每次变更换一个新对象、不变时返回同一个** —— `useSyncExternalStore` 靠引用判断
 * 「变没变」，每次读都造新对象会让它认为一直在变（见 `PluginsPanel` 的同一条判据）。
 */

import type { BrokenThemeReason } from '../../ipc/channels.js';

export interface ThemeDirectoryIssue {
  fileName: string;
  reason: BrokenThemeReason;
}

export interface ThemeDirectoryState {
  /** 读不出来的文件。来自启动时那一次扫描。 */
  broken: ThemeDirectoryIssue[];
  /** 写不进磁盘的文件名。会话内累积，写成功一次就清空。 */
  failed: string[];
}

const boot = window.nexus?.themeBoot;

let state: ThemeDirectoryState = { broken: [...(boot?.broken ?? [])], failed: [] };

const listeners = new Set<() => void>();

export function themeDirectoryState(): ThemeDirectoryState {
  return state;
}

export function subscribeThemeDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 一次同步的结果。**与上一次相同就不通知** —— 每次同步都通知会让订阅方白重渲染一遍。 */
export function reportThemeWriteFailures(failed: readonly string[]): void {
  if (sameNames(failed, state.failed)) return;
  state = { ...state, failed: [...failed] };
  for (const listener of [...listeners]) listener();
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}
