import { ipcRenderer } from 'electron';
import { THEME_STORAGE_KEY } from '@nexus/theme';
import { IPC_CHANNELS, type ThemeBootPayload, type ThemeBootRequest } from '../ipc/channels.js';

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
 *
 * ## 派生不在这里
 *
 * 这里只做一次字符串注入。**用户主题没有构建期静态 CSS**，它的 44 个 token 必须现派生 ——
 * 而派生一百多套实测 74ms、产物上百 KB，放在首帧之前跑等于直接把它加到窗口出现的时间上。
 * 所以派生在主进程（Node 环境，不受首帧约束），preload 只把它算好的 CSS 文本写进 DOM。
 *
 * ## 顺带修掉「用户主题首屏闪烁」
 *
 * 从前静态 CSS 只覆盖内置主题，用户主题靠 renderer 起来之后再注入 —— 首帧一定是默认主题，
 * 起来再跳。现在主进程手里有用户主题的种子，这一段 CSS 在首帧前就落下去了。
 */

/**
 * 用户主题存档的磁盘键（`appearance.userThemes` 的 `storageKey`）。
 *
 * 在这里**写死**而不是从 `settings/store.ts` 引：preload 与渲染进程是两套 bundle，引过去
 * 会把整个设置表（几十个 spec、依赖 core 与 command）拖进首帧之前的执行路径。
 */
const USER_THEME_STORAGE_KEY = 'nexus-user-theme';

/** 「存档已经写出成文件」的标记。写出**成功**之后才打，见主进程 `resolveThemeBoot`。 */
const THEME_MIGRATION_STORAGE_KEY = 'nexus-themes-migrated';

/**
 * 在 `<html>` 出现的瞬间写 `data-theme` 并注入主题变量。返回主进程算好的整份载荷
 * （渲染进程还要用它拿目录里的主题列表），拿不到时返回 `null`。
 */
export function installThemeBoot(doc: Document, win: Window): ThemeBootPayload | null {
  const read = (key: string): string | null => {
    try {
      return win.localStorage.getItem(key);
    } catch {
      // 存储被禁用：当作没有存档，按系统偏好走。
      return null;
    }
  };

  const request: ThemeBootRequest = {
    choice: read(THEME_STORAGE_KEY),
    prefersDark: win.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    storedThemes: read(USER_THEME_STORAGE_KEY),
    migrated: read(THEME_MIGRATION_STORAGE_KEY) === '1'
  };

  let payload: ThemeBootPayload;
  try {
    payload = ipcRenderer.sendSync(IPC_CHANNELS.getThemeBoot, request) as ThemeBootPayload;
  } catch (error) {
    // 拿不到就什么都不做：静态 CSS 里内置主题仍然对，用户主题会由 renderer 起来后补上
    // （即改动之前的行为）。这里**不抛** —— preload 抛错会把整个 bridge 带下去。
    console.error('[Nexus Preload] 取首帧主题失败，回落到静态 CSS:', error);
    return null;
  }

  if (payload.migrated) {
    try {
      win.localStorage.setItem(THEME_MIGRATION_STORAGE_KEY, '1');
    } catch {
      // 打不上标记只会让下次启动再走一遍迁移 —— 幂等，不报。
    }
  }

  const applyTheme = (): void => {
    if (doc.documentElement) doc.documentElement.dataset.theme = payload.themeId;
  };

  /**
   * 与 `ThemeManager` 的运行时注入**同一个元素、同一个 id**：渲染进程起来之后会覆盖它，
   * 内容也逐字相同（两边都从同一份 token 派生）。用 `<style>` 而不是内联样式，是因为
   * 44 个自定义属性写进 `style` 属性会让每个元素的 `style` 都带一份。
   */
  const applyVars = (): void => {
    if (!doc.head || !payload.cssText) return;
    let style = doc.getElementById('nexus-theme-vars');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'nexus-theme-vars';
      doc.head.appendChild(style);
    }
    style.textContent = payload.cssText;
  };

  if (doc.documentElement && doc.head) {
    applyTheme();
    applyVars();
    return payload;
  }

  const observer = new MutationObserver(() => {
    if (!doc.documentElement) return;
    applyTheme();
    if (!doc.head) return;
    observer.disconnect();
    applyVars();
  });
  observer.observe(doc, { childList: true, subtree: true });

  return payload;
}
