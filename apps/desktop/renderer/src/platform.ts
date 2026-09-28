import { CommandRegistry } from '@nexus/command';
import { LocaleManager } from '@nexus/i18n';
import { SYSTEM_THEME, ThemeManager, THEME_STORAGE_KEY } from '@nexus/theme';

export const commandRegistry = new CommandRegistry();
export const localeManager = new LocaleManager();

// 存档里是**选择**：`system` 或主题 id。缺省即「跟随系统」—— 与既有行为一致（没有存档时看系统
// 偏好），且存档恒可解读，不用区分「跟随」与「从未选过」。旧存档的 'dark' / 'light' 由
// `normalizeThemeChoice` 接住。
//
// 选择必须在**构造时**交进去，不能构造完再 setTheme：preload 已按同一规则写过 `data-theme`，
// 多一次写入就多一次「先画一帧再跳」的机会（见 `ThemeManager` 的构造注释）。
const savedThemeChoice =
  typeof localStorage === 'undefined' ? null : localStorage.getItem(THEME_STORAGE_KEY);

export const themeManager = new ThemeManager(savedThemeChoice ?? SYSTEM_THEME);

// 暴露给冒烟测试与调试（与 App 里的 `window.nexusSession` 同一套接缝）
if (typeof window !== 'undefined') {
  (window as unknown as { nexusLocale?: LocaleManager }).nexusLocale = localeManager;
}

if (typeof localStorage !== 'undefined') {
  const savedLocale = localStorage.getItem('nexus-locale');
  if (savedLocale === 'zh-CN' || savedLocale === 'en-US') {
    localeManager.setLocale(savedLocale);
  }
}

/**
 * 切换主题并落盘。
 *
 * 落盘的是**选择**（`themeChoice`）而不是解析结果 —— 跟随系统时解析结果会随系统偏好变，
 * 写回去等于退出跟随。也**不能**改成「订阅里落盘」：通知只在**解析结果**变化时触发，
 * 系统浅色时用户手选 Nexus Light，选择从 `system` 变成 `nexus-light` 而解析结果没变 ——
 * 那次选择就丢了。
 */
export function applyThemeChoice(choice: string): void {
  themeManager.setTheme(choice);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(THEME_STORAGE_KEY, themeManager.themeChoice);
  }
}

localeManager.subscribe((locale) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('nexus-locale', locale);
  }
});

/**
 * Mermaid 块「点击预览即露出源码」偏好。
 *
 * 默认 **关**：进源码的默认路径是 header 上的按钮（显式动作、效果可预期）。
 * 打开后点图 = 瞥一眼源码，光标一离开就回到预览。
 *
 * 与主题/语言同一套：localStorage 持久化 + 订阅广播；编辑器包只认注入进来的
 * facet，不读 localStorage。
 */
const MERMAID_CLICK_TO_REVEAL_KEY = 'nexus-mermaid-click-to-reveal';
const mermaidPreviewListeners = new Set<(value: boolean) => void>();

let mermaidClickToReveal = false;
if (typeof localStorage !== 'undefined') {
  mermaidClickToReveal = localStorage.getItem(MERMAID_CLICK_TO_REVEAL_KEY) === 'true';
}

export const mermaidPreviewPreference = {
  get(): boolean {
    return mermaidClickToReveal;
  },
  set(value: boolean): void {
    mermaidClickToReveal = value;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MERMAID_CLICK_TO_REVEAL_KEY, String(value));
    }
    mermaidPreviewListeners.forEach((listener) => listener(value));
  },
  subscribe(listener: (value: boolean) => void): () => void {
    mermaidPreviewListeners.add(listener);
    return () => {
      mermaidPreviewListeners.delete(listener);
    };
  }
};
