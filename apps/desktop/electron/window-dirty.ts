/**
 * 「哪些窗口有未保存的更改」。
 *
 * 从 `index.ts` 里抽出来，是因为**更新安装也要问同一件事**：`quitAndInstall()` 走
 * `app.quit()`，而主窗口的 `close` 处理器在文档脏时会 `preventDefault()` —— 绕过它就会
 * 丢数据，不绕过它用户看到的是「点了重启没反应」。两种失败都不可接受，唯一安全的方向是
 * **提前问清楚，脏的时候不给重启**。
 *
 * 用 `Set` 而不是 `Map<id, boolean>`：只关心「有没有」，不关心「哪一个」。
 */

const dirtyWindows = new Set<number>();

export function markWindowDirty(windowId: number, dirty: boolean): void {
  if (dirty) {
    dirtyWindows.add(windowId);
  } else {
    dirtyWindows.delete(windowId);
  }
}

export function isWindowDirty(windowId: number): boolean {
  return dirtyWindows.has(windowId);
}

/** 任意窗口有未保存的更改。窗口销毁时要 `forgetWindow`，否则残留的 id 会一直让这里为真。 */
export function hasUnsavedWindows(): boolean {
  return dirtyWindows.size > 0;
}

export function forgetWindow(windowId: number): void {
  dirtyWindows.delete(windowId);
}
