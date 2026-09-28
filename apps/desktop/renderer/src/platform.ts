import { CommandRegistry } from '@nexus/command';
import { LocaleManager } from '@nexus/i18n';
import { ThemeManager } from '@nexus/theme';
import { SettingsStore } from './settings/store.js';

export const commandRegistry = new CommandRegistry();
export const localeManager = new LocaleManager();

/**
 * 全部本机偏好的唯一入口。必须先于 `themeManager` 建 —— 主题的选择从这里读，「读存档」因此
 * 只有一处（preload 读的是同一份磁盘，规则共用 `normalizeThemeChoice`）。
 *
 * 存档里是**选择**：`system` 或主题 id。缺省即「跟随系统」—— 与既有行为一致（没有存档时看
 * 系统偏好），且存档恒可解读，不用区分「跟随」与「从未选过」。
 */
export const settings = new SettingsStore();

// 选择必须在**构造时**交进去，不能构造完再 setTheme：preload 已按同一规则写过 `data-theme`，
// 多一次写入就多一次「先画一帧再跳」的机会（见 `ThemeManager` 的构造注释）。
export const themeManager = new ThemeManager(settings.get('appearance.theme'));

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
 * 切换主题：**选择**落进 store（落盘 + 广播），解析仍归 `ThemeManager`。
 *
 * 两条通知分工不同，缺一不可：store 的通知在**选择**变化时发（设置页的单选态要它），
 * `ThemeManager` 的通知在**解析结果**变化时发（`useTheme` 重渲染要它）。系统浅色时选「跟随
 * 系统」→ 选择变了、解析结果没变 → 只有前者发得出来。合成一条就会丢掉这次选择。
 */
export function applyThemeChoice(choice: string): void {
  settings.set('appearance.theme', choice);
  themeManager.setTheme(choice);
}

localeManager.subscribe((locale) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('nexus-locale', locale);
  }
});

/**
 * Mermaid 块「点击预览即露出源码」偏好。默认 **关**：进源码的默认路径是 header 上的按钮
 * （显式动作、效果可预期），打开后点图 = 瞥一眼源码，光标一离开就回到预览。
 *
 * 编辑器包只认注入进来的 facet、不读 localStorage。**本期不迁进 `SettingsStore`** ——
 * 它现在能用、迁移是纯风险，且所属的 Editor 分组本期不做（`docs/phase-4-plan.md` §5.1 约束 ③）。
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
