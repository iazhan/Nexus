/**
 * 这个渲染进程是哪个窗口。
 *
 * **设置与主题编辑器都是独立窗口，不是主窗口里的视图。** 三个窗口跑的是**同一份产物**，
 * 靠 URL 查询串区分角色 —— 另开一个构建目标意味着主题、i18n、设置存档、样式全都要么抽公共包
 * 要么抄一遍，而它们本来就该是同一套代码。
 *
 * 为什么走查询串而不是 IPC：角色必须在**首帧之前**确定。`getLaunchContext` 是异步 invoke，
 * 等它回来再决定渲染什么，用户会先看到主界面闪一下再变成设置页。查询串在 `main.tsx` 里是
 * 同步可读的，零闪烁、零往返。
 *
 * 联合类型来自 `ipc/channels.ts` —— 主进程 `loadRenderer()` 用的是同一个，两边不会各自漂移。
 */

import type { WindowRole } from '../../ipc/channels.js';

export type { WindowRole };

/** 主进程 `WINDOW_ROLE_PARAM` 的另一半，两边必须一致。 */
const ROLE_PARAM = 'window';

/**
 * 查询串里的取值 → 角色。**认不出的值一律当主窗口** —— 宁可多开一个主界面，
 * 也不要因为一个拼错的参数把用户丢进一个只有设置的窗口里。
 */
const ROLE_BY_VALUE: Record<string, WindowRole> = {
  settings: 'settings',
  theme: 'theme',
  update: 'update'
};

export function readWindowRole(search: string): WindowRole {
  const value = new URLSearchParams(search).get(ROLE_PARAM);
  return (value && ROLE_BY_VALUE[value]) || 'main';
}
