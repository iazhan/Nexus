import { BUILT_IN_THEMES, resolveKnownThemeId, THEME_STORAGE_KEY } from '@nexus/theme';

/**
 * 首帧前的主题引导。
 *
 * 主题一旦由 `data-theme` 选择，「用哪套主题」就必须在首帧前定下来，否则会先按默认主题画一帧。
 * renderer 做不到（它的 bundle 求值时首帧已排上队），preload 可以：它早于页面脚本，不受 CSP 约束。
 *
 * 2026-09-28 spike 实测（Electron 34.5.8，sandbox + contextIsolation + CSP `script-src 'self'`）：
 *   - preload 执行时 `document.documentElement` 是 **null**、readyState 是 'loading'，
 *     所以不能直接写属性，必须等 `<html>` 出现；
 *   - MutationObserver 在 9.6ms 捕获到它，页面脚本 11ms 才跑，`ready-to-show`
 *     （Electron 保证「可显示且不闪」的信号）在 338ms —— 早 328ms；
 *   - `localStorage` 在 sandbox preload 里可读，且 t0 就能读；
 *   - 内联脚本被页面 CSP 拦掉，preload 照常执行 —— 这正是本方案不用碰 CSP 的原因。
 */

/** 静态 CSS 只覆盖内置主题（用户主题靠 renderer 的运行时注入），所以这里只认内置 id。 */
const builtInIds = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

/**
 * 在 `<html>` 出现的瞬间写 `data-theme`，值是**解析后**的主题 id（CSS 选择器只认 id）。
 * 只写这一个属性：`colorScheme` 与 `<style id="nexus-theme-vars">` 归 renderer 的
 * `ThemeManager`，窗口在 `ready-to-show` 前不可见，那两件来得及。认不出的 id 在这里就换成
 * 跟随系统的结果 —— 静态 CSS 里没有它，写出去等于一个变量都没有。
 */
export function installThemeBoot(doc: Document, win: Window): void {
  let saved: string | null = null;
  try {
    saved = win.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // 存储被禁用：当作没有存档，按系统偏好走。
  }

  const prefersDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const themeId = resolveKnownThemeId(saved, prefersDark, (id) => builtInIds.has(id));

  const apply = (): void => {
    if (!doc.documentElement) return;
    doc.documentElement.dataset.theme = themeId;
  };

  if (doc.documentElement) {
    apply();
    return;
  }

  const observer = new MutationObserver(() => {
    if (!doc.documentElement) return;
    observer.disconnect();
    apply();
  });
  observer.observe(doc, { childList: true, subtree: true });
}
