import { CommandRegistry } from '@nexus/command';
import { LocaleManager } from '@nexus/i18n';
import {
  DEFAULT_THEME_CHOICE,
  ThemeManager,
  formatSelection,
  mergeUserThemes,
  parseSelection,
  userThemeName,
  userThemeVariants,
  type Base16Slot,
  type NexusThemeScheme,
  type Tuning,
  type UserTheme
} from '@nexus/theme';
import { SettingsStore } from './settings/store.js';
import { EDITOR_CSS_VARS, editorFontStack } from './settings/editor-typography.js';

export const commandRegistry = new CommandRegistry();
export const localeManager = new LocaleManager();

/** 语言偏好的磁盘键。跨窗口同步与写盘两处都要它。 */
const LOCALE_STORAGE_KEY = 'nexus-locale';

/**
 * 全部本机偏好的唯一入口。必须先于 `themeManager` 建 —— 主题的选择从这里读，「读存档」因此
 * 只有一处（preload 读的是同一份磁盘，规则共用 `normalizeThemeChoice`）。
 *
 * 存档里是**选择**：`<预设>@<模式>`，或一条裸方案 id（用户主题）。缺省即「默认预设 + 自动」
 * —— 与既有行为一致（没有存档时看系统偏好），且存档恒可解读，不用区分「跟随」与「从未选过」。
 */
export const settings = new SettingsStore();

const savedUserThemes = settings.get('appearance.userThemes');

// 选择与用户主题都必须在**构造时**交进去，不能构造完再 setTheme / registerUserTheme：preload
// 已按同一规则写过 `data-theme`，多一次写入就多一次「先画一帧再跳」的机会（见 `ThemeManager`
// 的构造注释）。用户主题晚注册还会让首帧落在内置主题上。
export const themeManager = new ThemeManager(
  settings.get('appearance.theme'),
  undefined,
  savedUserThemes
);

// 暴露给冒烟测试与调试（与 App 里的 `window.nexusSession` 同一套接缝）
if (typeof window !== 'undefined') {
  (window as unknown as { nexusLocale?: LocaleManager }).nexusLocale = localeManager;
}

/** 读存档里的语言。读不到（或值不认识）时返回 `null`，交给调用方决定要不要动。 */
function readStoredLocale(): 'zh-CN' | 'en-US' | null {
  if (typeof localStorage === 'undefined') return null;
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  return saved === 'zh-CN' || saved === 'en-US' ? saved : null;
}

const initialLocale = readStoredLocale();
if (initialLocale) localeManager.setLocale(initialLocale);

/**
 * 切换主题：**选择**落进 store（落盘 + 广播），解析仍归 `ThemeManager`。
 *
 * 两条通知分工不同，缺一不可：store 的通知在**选择**变化时发（设置页的单选态要它），
 * `ThemeManager` 的通知在**解析结果**变化时发（`useTheme` 重渲染要它）。系统浅色时选「跟随
 * 系统」→ 选择变了、解析结果没变 → 只有前者发得出来。合成一条就会丢掉这次选择。
 *
 * 改覆盖项走的是 `ThemeManager` 那条：主题 id 没变，store 收不到任何变化。
 */
export function applyThemeChoice(choice: string): void {
  settings.set('appearance.theme', choice);
  themeManager.setTheme(choice);
}

/**
 * 把一份用户主题写回列表：**同 id 替换，否则追加**。
 *
 * 其余条目原样保留 —— 用户可以同时拥有多套自定义主题，覆盖写会让「切走一套就丢一套」。
 */
function upsertUserTheme(theme: UserTheme): void {
  const list = settings.get('appearance.userThemes');
  settings.set(
    'appearance.userThemes',
    list.some((item) => item.id === theme.id)
      ? list.map((item) => (item.id === theme.id ? theme : item))
      : [...list, theme]
  );
}

/** 把当前用户主题落盘。落在内置主题上时无事可做。 */
function persistActiveUserTheme(): void {
  const theme = themeManager.activeUserTheme;
  if (theme) upsertUserTheme(theme);
}

/** 注册并切到一个用户主题。导入 / fork 之后的统一入口 —— 注册与选择都落盘。 */
export function applyUserTheme(theme: UserTheme): void {
  // id 不合法（内置 id）时 `registerUserTheme` 回 false：不落盘、不切换，免得存档里出现一个
  // 「看着像用户主题、实际是内置主题」的条目。
  if (!themeManager.registerUserTheme(theme)) return;
  upsertUserTheme(theme);

  // 用户主题是一条**预设**（明暗两版共用 id），所以选择要带模式轴。不带的话设置页的模式卡片
  // 对它恒等 —— 裸 id 没有预设轴，按下去没反应。
  //
  // 已经切到它身上了（`forkSchemeToUserTheme` 刚落点）就沿用那条选择，别推回第一版：
  // 从深色那套复制出来的副本该停在深色，而它的第一版是浅色。
  const current = parseSelection(settings.get('appearance.theme'));
  const landed = 'preset' in current && current.preset === theme.id ? current.mode : undefined;
  applyThemeChoice(
    formatSelection({ preset: theme.id, mode: landed ?? userThemeVariants(theme)[0] ?? 'light' })
  );
}

/** 从列表里移除一套用户主题。正落在它身上时先切回默认预设 —— 否则选择会指向一个不存在的预设。 */
export function removeUserTheme(id: string): void {
  const list = settings.get('appearance.userThemes');
  if (!list.some((item) => item.id === id)) return;

  if (themeManager.theme.id === id) applyThemeChoice(DEFAULT_THEME_CHOICE);
  const next = list.filter((item) => item.id !== id);
  settings.set('appearance.userThemes', next);
  // 注册表跟着换一份：留着的话它的 id 还能被选择引用，「删了却还能切回去」。
  themeManager.setUserThemes(next);
}

/**
 * 把 `sourceId` 并进 `targetId`，并移除被并掉的那套。返回合并后的主题，没有可并的就回 `null`。
 *
 * 这是个**不可逆**的动作（被并掉的那套从列表消失），调用方负责先问过用户。
 */
export function mergeUserThemeInto(targetId: string, sourceId: string): UserTheme | null {
  const list = settings.get('appearance.userThemes');
  const target = list.find((item) => item.id === targetId);
  const source = list.find((item) => item.id === sourceId);
  if (!target || !source || targetId === sourceId) return null;

  const merged = mergeUserThemes(target, source);
  const next = list
    .filter((item) => item.id !== sourceId)
    .map((item) => (item.id === targetId ? merged : item));

  // 被并掉的那套如果正是当前选择，改指到合并后的那套 —— 否则选择悬空。
  const selection = parseSelection(settings.get('appearance.theme'));
  const selected = 'preset' in selection ? selection.preset : selection.id;
  if (selected === sourceId) {
    const mode = 'preset' in selection ? selection.mode : 'auto';
    settings.set('appearance.userThemes', next);
    themeManager.setUserThemes(next);
    applyThemeChoice(formatSelection({ preset: targetId, mode }));
    return merged;
  }

  settings.set('appearance.userThemes', next);
  themeManager.setUserThemes(next);
  return merged;
}

/**
 * 把一版方案写进当前主题的**对应变体**（没有就补一版），并切到那一版。
 *
 * 落点是**方案自己的 `variant`**，不是「当前正在编辑的那一版」。浅色配色写进深色那一版会让
 * 派生方向与配色相反（`base00` 是浅色、却按深色去算），对比度当场崩掉 —— 而派生方向只由
 * `scheme.variant` 决定，改不了。
 *
 * 缺哪一版就**补哪一版**：这就是「导入一份浅色 + 一份深色 = 一套双色主题」的机制，也是单边
 * 主题唯一的出路（否则切到另一边是死路，见 `docs/theme-window-closeout.md` §5.10）。
 *
 * 名字沿用主题**已有的**那个 —— 粘贴改的是配色，不是标签。
 */
export function applyVariantScheme(scheme: NexusThemeScheme): { id: string; added: boolean } | null {
  if (!themeManager.isEditable && !themeManager.forkActiveToUserTheme()) return null;
  const theme = themeManager.activeUserTheme;
  if (!theme) return null;

  const name = userThemeName(theme);
  const added = !theme.variants[scheme.variant];
  const next: UserTheme = {
    id: theme.id,
    variants: { ...theme.variants, [scheme.variant]: name ? { ...scheme, name } : scheme }
  };

  themeManager.registerUserTheme(next);
  upsertUserTheme(next);
  applyThemeChoice(formatSelection({ preset: theme.id, mode: scheme.variant }));
  return { id: theme.id, added };
}

/**
 * 「新建主题」与「复制」共用的动作：以 `sourceSchemeId` 那套为起点造一份用户主题并切过去。
 *
 * 源是**方案 id**（`dracula` / `nexus-light` / `user:<uuid>`），不是预设 id —— 预设的明暗两版
 * 是两套方案，用户主题只装得下一版。调用方负责把族解析成具体那一版。
 *
 * 复制出来立刻切过去：编辑器跟着展开（它的显隐判据就是「当前主题是用户主题」），用户看到的是
 * 一份可以马上改的副本。落盘复用 `applyUserTheme`，与导入走同一条路。
 */
export function duplicateTheme(sourceSchemeId: string): boolean {
  const theme = themeManager.forkSchemeToUserTheme(sourceSchemeId);
  if (!theme) return false;
  applyUserTheme(theme);
  return true;
}

/**
 * 批量写覆盖项（`null` 表示删掉该项）。
 *
 * **落在内置主题上时先 fork** —— 内置主题不可写，否则「切回 Nexus Light」得到的是改过的
 * Nexus Light，用户没有退路。fork 只发生在这一处，`ThemeManager` 保持机械（它只回 `false`）。
 */
export function applyOverrides(patch: Readonly<Record<string, string | null>>): void {
  if (!themeManager.isEditable && !themeManager.forkActiveToUserTheme()) return;
  if (!themeManager.patchOverrides(patch)) return;
  persistActiveUserTheme();
}

/**
 * 批量改当前主题的**名字与种子**（16 色 / 系数）。基础档走这条路 —— 它改完让派生重跑一遍，
 * 而 `applyOverrides()` 改的是派生结果之上的单个 token。
 *
 * 名字也走这里：它同样是「方案自身的一部分」，另开一条 `renameActiveTheme()` 只会让「哪些字段
 * 属于方案」这件事多一个入口。空名由 `patchScheme` 挡下，调用方不必自己校验。
 *
 * 与 `applyOverrides()` 同一条纪律：内置主题上先 fork。
 */
export function applySchemePatch(patch: {
  name?: string;
  palette?: Partial<Record<Base16Slot, string>>;
  tuning?: Partial<Tuning>;
}): void {
  if (!themeManager.isEditable && !themeManager.forkActiveToUserTheme()) return;
  if (!themeManager.patchScheme(patch)) return;
  persistActiveUserTheme();
}

localeManager.subscribe((locale) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
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

function readStoredMermaidPreference(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(MERMAID_CLICK_TO_REVEAL_KEY) === 'true';
}

let mermaidClickToReveal = readStoredMermaidPreference();

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
    // 与 `SettingsStore.set()` 同一个理由：谁改的谁广播。少了这一句，将来 Editor 分组接上
    // 这个偏好时，只有改它的那个窗口会变。
    announceLocalChange();
  },
  /** 另一个窗口改过之后追上磁盘。**不写盘** —— 写盘会让两个窗口互相触发。 */
  reload(): void {
    const next = readStoredMermaidPreference();
    if (next === mermaidClickToReveal) return;
    mermaidClickToReveal = next;
    mermaidPreviewListeners.forEach((listener) => listener(next));
  },
  subscribe(listener: (value: boolean) => void): () => void {
    mermaidPreviewListeners.add(listener);
    return () => {
      mermaidPreviewListeners.delete(listener);
    };
  }
};

/**
 * 把「另一个窗口改了存档」同步过来。
 *
 * 上游是主进程的中转（见 `ipc/channels.ts` 的 `notifySettingsChanged`），不是 `storage` 事件 ——
 * dev 是 http、打包是 `file://`，后者下 `storage` 事件是否跨窗口派发不能赌。
 *
 * 这条路径**只读不写**：`settings.reload()` 只重读，`themeManager.setTheme()` 只改内存与 DOM。
 * 顺手写一次存档的话两个窗口就会互相触发，转成死循环。
 *
 * 顺序上**先注册用户主题再选主题**：主题被改过（覆盖项 / 种子）时 `setTheme()` 的 `changed`
 * 判据比的是 token 值，注册在前新值才参与比较；反过来 id 没变、比较的是旧 preset，
 * 主窗口就不会重绘 —— 表现是「在设置窗口拖了滑块，主窗口纹丝不动」。
 */
export function resyncFromStorage(): void {
  settings.reload();

  // 整表替换：另一个窗口删掉一套主题时，合并会让它继续留在内存里，「删了却还能切回去」。
  themeManager.setUserThemes(settings.get('appearance.userThemes'));
  themeManager.setTheme(settings.get('appearance.theme'));

  const savedLocale = readStoredLocale();
  if (savedLocale) localeManager.setLocale(savedLocale);

  mermaidPreviewPreference.reload();

  // 排版五项走 `settings.reload()` 那条订阅（见下），这里不必重复调 —— 但**必须**留一行说明
  // 为什么：漏掉订阅的人会以为它靠这里同步。
}

/**
 * 把编辑器排版设置写进 `documentElement` 的 CSS 变量。
 *
 * 为什么走 CSS 变量而不是重建 CodeMirror 主题：`EditorView.theme()` 的值只在**构造时**求值，
 * 改字号得 reconfigure 整个 theme compartment，还要保住光标与滚动位置。变量是纯 CSS 层，
 * 五个设置项一个 effect 都不用加。
 *
 * **在模块加载时调一次、并在这里订阅**，不交给 `App.tsx`：订阅放在消费方，将来多一个渲染
 * 编辑器的窗口就要多记一次；放在这里，谁 import `platform` 谁就已经接好了。模块加载时就跑
 * 一次也是必需的 —— 它发生在 React 首次渲染之前，所以自定义字号不会先闪一帧 14px。
 *
 * 主题窗口与设置窗口也跑这段（同一个 bundle），对它们无害：那两个窗口没有编辑器。
 */
export function applyEditorTypography(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;

  root.setProperty(EDITOR_CSS_VARS.fontSize, `${settings.get('editor.fontSize')}px`);
  root.setProperty(EDITOR_CSS_VARS.lineHeight, String(settings.get('editor.lineHeight')));
  root.setProperty(
    EDITOR_CSS_VARS.paragraphSpacing,
    `${settings.get('editor.paragraphSpacing')}px`
  );
  root.setProperty(EDITOR_CSS_VARS.contentWidth, settings.get('editor.contentWidth'));
  root.setProperty(EDITOR_CSS_VARS.fontFamily, editorFontStack(settings.get('editor.fontFamily')));
}

applyEditorTypography();

for (const path of [
  'editor.fontSize',
  'editor.lineHeight',
  'editor.paragraphSpacing',
  'editor.contentWidth',
  'editor.fontFamily'
] as const) {
  settings.subscribe(path, applyEditorTypography);
}

/**
 * 本窗口刚改了本机偏好：让主进程广播给别的窗口。
 *
 * 三个写入口（`SettingsStore.set` / 语言 / mermaid 偏好）都要调它 —— 漏一个的症状是
 * 「在这个窗口改了，另一个窗口不动」，而且只在那个特定偏好上出现，很难联想到广播。
 */
function announceLocalChange(): void {
  if (typeof window === 'undefined') return;
  window.nexus?.notifySettingsChanged?.();
}

settings.onWrite(announceLocalChange);
localeManager.subscribe(announceLocalChange);

if (typeof window !== 'undefined') {
  window.nexus?.onSettingsChanged?.(() => resyncFromStorage());
}
