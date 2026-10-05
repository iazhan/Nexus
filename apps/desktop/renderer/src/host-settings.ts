/**
 * 把**主进程要照着做**的设置值送过去。
 *
 * ## 为什么需要一条单独的通道
 *
 * 本机偏好存在本渲染进程的存储里，主进程读不到。凡是要主进程照着做的设置
 * （扫描工作区跳过哪些目录，在主进程的 walker 里发生；每个文档留几份历史快照，
 * 在主进程的 `HistoryStore` 里发生），只能由这边显式送一份过去。
 *
 * ## 为什么要能等
 *
 * 索引启动紧跟着设置同步。只发不等的话，第一次建索引有可能跑在旧规则上 ——
 * 症状是「填了忽略规则，第一次没生效，按一次重建索引才对」，一个查不出来的时序问题。
 * 所以 `syncHostSettings` 是 `invoke`，这里把最近一次推送的 Promise 交出去
 * （`hostSettingsSynced()`），由**触发扫描的地方**自己 await。
 *
 * ## 为什么三个窗口都推
 *
 * 它们共用同一份存储（同一个 origin），推的值一样，后到的覆盖先到的结果相同。
 * 只让主窗口推的话，就得先回答「用户是在哪个窗口改的设置」，而设置窗口与主题窗口
 * 都改得动它。
 */

import { parseHistoryRetention, parseIgnoreRules } from '@nexus/core';
import type { HostSettings } from '../../ipc/channels.js';
import { settings } from './platform.js';
import { disabledMembers } from './settings/preference-specs.js';
import { BUILTIN_CAPABILITY_IDS } from './capability-roster.js';

/**
 * 主进程关心的那一份。**加一项时这里与 `HostSettings` 一起改** ——
 * 判据很硬：没有它，主进程的某个行为就是错的。
 */
function currentHostSettings(): HostSettings {
  return {
    ignoreRules: parseIgnoreRules(settings.get('files.ignoreRules')),
    historyRetention: parseHistoryRetention(settings.get('data.historyRetention')),
    restoreLastWorkspace: settings.get('general.restoreLastWorkspace'),
    // 送的是**归一化后的成员数组**，不是存档里的原串：主进程只做 `includes` 查表，
    // 不该让它也懂「逗号分隔 + 顺序 + 去重」这套存档格式（那正是 `disabledMembers` 的职责）。
    disabledCapabilities: disabledMembers(
      BUILTIN_CAPABILITY_IDS,
      settings.get('plugins.disabled')
    )
  };
}

/**
 * 要订阅的设置键。**每加一项就要在这里加一行** —— 漏了不会报错，
 * 症状是「改了设置要重启才生效」。
 *
 * `subscribe` 一次只收一个键，所以这里是数组而不是单个字符串。
 */
const WATCHED: ReadonlyArray<
  | 'files.ignoreRules'
  | 'data.historyRetention'
  | 'general.restoreLastWorkspace'
  | 'plugins.disabled'
> = [
  'files.ignoreRules',
  'data.historyRetention',
  'general.restoreLastWorkspace',
  'plugins.disabled'
];

/** 最近一次推送。串起来是为了「改得快」时后一次不会先落地。 */
let pending: Promise<void> = Promise.resolve();

function push(): void {
  pending = pending
    .then(async () => {
      const bridge = window.nexus?.syncHostSettings;
      if (typeof bridge !== 'function') return;
      await bridge(currentHostSettings());
    })
    .catch((err: unknown) => {
      // 推送失败不该让渲染进程炸掉：主进程会退回「只有内置规则」，
      // 而那是加这条通道之前的行为 —— 退化的方向是安全的。
      console.error('同步宿主设置失败:', err);
    });
}

/** 等到「当前的设置已经送到主进程」。触发扫描之前 await 它。 */
export function hostSettingsSynced(): Promise<void> {
  return pending;
}

/**
 * 启动同步：立刻推一次，之后每次改设置再推。
 *
 * 由 `main.tsx` 显式调用而不是模块级副作用：三个窗口都跑那份入口，
 * 而「什么时候第一次推送」是这条链路正确性的一部分，不该藏在一个 import 里。
 *
 * 返回取消订阅的函数（与 `settings.subscribe` 同形）。生产路径忽略它 —— 入口只跑一次；
 * 用例里必须还原，否则同一个进程里上一个用例的订阅会继续往它的 spy 上推。
 */
export function startHostSettingsSync(): () => void {
  push();
  const unsubscribes = WATCHED.map((path) => settings.subscribe(path, push));
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
