/**
 * 主进程侧的「宿主设置」缓存 —— 渲染进程送过来的那一份，存在内存里。
 *
 * ## 为什么需要它
 *
 * 本机偏好存在渲染进程的存储里，**主进程读不到**。而有些设置是「主进程必须照着做」的：
 * 扫描工作区跳过哪些目录（在主进程的 walker 里发生）、每个文档留几份历史快照
 * （在主进程的 `HistoryStore` 里发生）。这类设置只能由渲染进程显式送一份过来
 * （`syncHostSettings` 通道），主进程存下来，干活时现读。
 *
 * ## 为什么是内存而不是落盘
 *
 * 渲染进程在启动时就会送一次（`renderer/src/host-settings.ts` 在模块加载时推），
 * 所以主进程不需要自己持久化 —— 存盘反而会多出「磁盘上那份与渲染进程那份不一致」的
 * 第二个事实源，而症状是「设置页改了、重启后主进程还用着旧的」。
 *
 * **一处例外：`restoreLastWorkspace`。** 它的消费者是**下一次启动**的 `launchContext`，
 * 而那个值在主进程模块加载时就定了 —— 那一刻还没有渲染进程，送不过来。所以它由
 * `recent-workspace.ts` 单独落盘。判据是「这个值在第一个渲染进程存在之前就要被读到」，
 * 不满足这条的字段一律留在内存里。
 *
 * ## 为什么不是全局单例的 FileService 字段
 *
 * 主进程确实只有一个实例，但 `FileService` 是**被构造出来的**、可以有多份（测试里就
 * 有多份）。把规则塞进它的字段等于「每个实例各有一份快照」，改设置只更新到某一个上。
 * 这里是一份模块级的当前值，谁读都是同一份。
 */

import { parseLogLevel, type CapabilityEnabled } from '@nexus/core';
import { DEFAULT_HOST_SETTINGS, type HostSettings } from '../ipc/channels.js';

let current: HostSettings = DEFAULT_HOST_SETTINGS;

/**
 * 校验一份来自渲染进程的载荷。**逐个字段判，不整体信任** ——
 * `HostSettings` 是编译期的形状，跨进程边界之后运行时什么都能传进来。
 *
 * 只认自己知道的键，多出来的一律忽略（前向兼容：将来渲染进程先于主进程升级，
 * 多送一个字段不该让整条通道报错）。认得的键类型不对就抛 —— 静默丢掉会让
 * 「设置页改了没生效」变成一个查不出来的状态。
 */
export function sanitizeHostSettings(raw: unknown): Partial<HostSettings> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('syncHostSettings: 载荷必须是对象');
  }

  const patch: Partial<HostSettings> = {};
  const candidate = raw as Record<string, unknown>;

  if ('ignoreRules' in candidate) {
    const rules = candidate.ignoreRules;
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')) {
      throw new Error('syncHostSettings: ignoreRules 必须是字符串数组');
    }
    patch.ignoreRules = rules as string[];
  }

  if ('historyRetention' in candidate) {
    const retention = candidate.historyRetention;
    // `null` 是合法值（＝不清理），不是「字段缺失」。负数与小数直接拒 ——
    // 这一个字段是**删数据**的开关，宁可让整条通道报错，也不猜用户想表达什么。
    if (retention !== null && (typeof retention !== 'number' || !Number.isInteger(retention) || retention < 0)) {
      throw new Error('syncHostSettings: historyRetention 必须是非负整数或 null');
    }
    patch.historyRetention = retention as number | null;
  }

  if ('restoreLastWorkspace' in candidate) {
    const restore = candidate.restoreLastWorkspace;
    // 严格收 `boolean`：`'true'` / `1` 这类「看着像」的值一律拒。它决定的是
    // **下一次启动要不要对一个目录做授权**，猜错的方向是「不该开的开了」。
    if (typeof restore !== 'boolean') {
      throw new Error('syncHostSettings: restoreLastWorkspace 必须是布尔值');
    }
    patch.restoreLastWorkspace = restore;
  }

  if ('disabledCapabilities' in candidate) {
    const disabled = candidate.disabledCapabilities;
    // 与 `ignoreRules` 同形：字符串数组，逐项判。**不在这里比对 id 是否认得** ——
    // 认得哪些 id 是渲染进程名册的事，主进程只照着自己那一份处理器表查表；
    // 多出来的 id 一律忽略（前向兼容：渲染进程先升级时不该让整条通道报错）。
    if (!Array.isArray(disabled) || disabled.some((id) => typeof id !== 'string')) {
      throw new Error('syncHostSettings: disabledCapabilities 必须是字符串数组');
    }
    patch.disabledCapabilities = disabled as string[];
  }

  if ('logLevel' in candidate) {
    const level = candidate.logLevel;
    // 类型必须是字符串：**认不出的「值」**回落默认档（`parseLogLevel`），
    // 但一个数字或对象说明载荷本身坏了 —— 那要报错，而不是猜一个级别。
    // 这与上面几条「类型不对就抛」是同一条纪律。
    if (typeof level !== 'string') {
      throw new Error('syncHostSettings: logLevel 必须是字符串');
    }
    patch.logLevel = parseLogLevel(level);
  }

  return patch;
}

/** 合并一份已校验的补丁。未出现的键保持原值 —— 载荷是补丁，不是整份替换。 */
export function updateHostSettings(patch: Partial<HostSettings>): void {
  current = { ...current, ...patch };
}

/**
 * 给主进程的注册表用的启停谓词：**每次调用现读当前值**，所以拨开关立即生效。
 *
 * 与渲染进程那份（`settings/preference-specs.ts` 的 `isCapabilityDisabled(raw, id)`）是
 * **两个不同的答案，不是同一份口径的第二处实现**：那个问的是「用户在设置里关掉了什么」
 * （读存档字符串），这个问的是「主进程现在照哪一份做事」（读已经送过来的那一份）。
 * 两边都只有一处，不存在「同一个状态在两个地方拼出不同结果」。
 *
 * 注意它**不检查 id 认不认识** —— 渲染进程送来的表里也有渲染进程内那 5 个能力的 id，
 * 而主进程不认识它们。这里只回答「在不在被关掉的表里」，认不认识由调用方（自己的
 * 处理器表）决定：`ProcessorRegistry` 只会拿自己注册过的 id 来问。
 */
export const hostCapabilityEnabled: CapabilityEnabled = (id) =>
  !current.disabledCapabilities.includes(id);

/** 当前值。调用方**不要缓存返回值** —— 它就是「现在这一份」。 */
export function hostSettings(): HostSettings {
  return current;
}

/** 回到初始值。测试用：`singleFork` 下模块状态跨文件共享，不还原会渗到后面的用例。 */
export function resetHostSettings(): void {
  current = DEFAULT_HOST_SETTINGS;
}
