/**
 * 主题**选择**与**解析**分开：存档存选择，渲染用解析结果 id。合成一个的话，跟随系统时写回存档
 * 会把选择覆盖成具体 id，跟随当场丢失。preload 与 renderer 共用（不碰 DOM），两边解析不一致
 * 会「先按 A 画一帧、起来再跳 B」。
 *
 * 选择是**两轴**的：预设（哪一族）× 模式（浅色 / 自动 / 深色）。存档里压成一个字符串
 * `<预设>@<模式>` —— preload 必须在首帧之前同步解析出 `data-theme`，多开一个存档键就多一次
 * 读盘，也多一次「两处不一致」的机会。
 *
 * **裸方案 id（不含 `@`）仍然合法**，含义是「这套方案就是它自己」：用户主题只有一版，没有模式
 * 可谈；旧存档里存的也全是裸 id，靠方案→预设的反查表升成新格式。
 *
 * 分隔符用 `@` 而不是 `:` 或 `-`：方案 id 里有 `-`，用户主题 id 里有 `:`。
 */

import { BUILT_IN_PRESETS } from './seeds.js';

/** 存档键。与 `platform.ts`、`preload/theme-boot.ts` 必须一致。 */
export const THEME_STORAGE_KEY = 'nexus-theme';

const MODE_SEPARATOR = '@';

export type ThemeMode = 'light' | 'auto' | 'dark';

/** 模式轴的顺序就是界面上的顺序：跟随系统 → 浅色 → 深色。设置页的卡片与菜单投影都读它。 */
export const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];

/** 旧存档里的「跟随系统」哨兵值。新格式里它等价于「默认预设 + 自动」。 */
export const SYSTEM_THEME = 'system';

/** 自动模式、以及一切回落（认不出的预设、认不出的方案）的落点。 */
export const DEFAULT_PRESET = 'nexus';

/** 出厂默认选择。也是 `store.ts` 的 fallback。 */
export const DEFAULT_THEME_CHOICE = `${DEFAULT_PRESET}${MODE_SEPARATOR}auto`;

/**
 * 默认预设的两个变体。静态 CSS 的基线（`:root`）读它 —— 构建期就要定下基线，不能去查预设表。
 * 与 `BUILT_IN_PRESETS` 里 nexus 那一族的一致性由测试守着。
 */
export const SYSTEM_DEFAULTS: Record<'light' | 'dark', string> = {
  light: 'nexus-light',
  dark: 'nexus-dark'
};

/**
 * 解析后的选择。两种形状：
 * - `{ preset, mode }` —— 有预设轴，模式决定取哪一边；
 * - `{ id }` —— 裸方案 id：用户主题，或一条认不出的存档。
 */
export type ThemeSelection = { preset: string; mode: ThemeMode } | { id: string };

export function isThemeMode(value: string): value is ThemeMode {
  return value === 'light' || value === 'auto' || value === 'dark';
}

/** 预设 id → 明暗两边的方案 id。生成物是权威，这里只做索引。 */
const presetVariants = new Map<string, { light?: string; dark?: string }>(
  BUILT_IN_PRESETS.map((preset) => [preset.id, preset.variants])
);

/** 方案 id → 它属于哪个预设的哪一边。旧存档迁移靠它。 */
const schemeToPreset = new Map<string, { preset: string; mode: 'light' | 'dark' }>();
for (const preset of BUILT_IN_PRESETS) {
  if (preset.variants.light) {
    schemeToPreset.set(preset.variants.light, { preset: preset.id, mode: 'light' });
  }
  if (preset.variants.dark) {
    schemeToPreset.set(preset.variants.dark, { preset: preset.id, mode: 'dark' });
  }
}

export function presetVariantsOf(presetId: string): { light?: string; dark?: string } | undefined {
  return presetVariants.get(presetId);
}

/** 预设 id → 族名。fork 用户主题时用它给副本起名。用户主题不在表里，回 `null`。 */
const presetNames = new Map<string, string>(BUILT_IN_PRESETS.map((preset) => [preset.id, preset.name]));

export function presetNameOf(presetId: string): string | null {
  return presetNames.get(presetId) ?? null;
}

/** 这套方案属于哪个预设的哪一边。用户主题与认不出的 id 回 `null`。 */
export function presetOfScheme(schemeId: string): { preset: string; mode: 'light' | 'dark' } | null {
  return schemeToPreset.get(schemeId) ?? null;
}

export function formatSelection(selection: ThemeSelection): string {
  return 'preset' in selection
    ? `${selection.preset}${MODE_SEPARATOR}${selection.mode}`
    : selection.id;
}

/**
 * 旧存档 → 新格式。三种旧值都要接住：
 *
 * - 缺省 / `system` → 默认预设 + 自动（与既有行为一致：没有存档时看系统偏好）；
 * - 裸的 `dark` / `light` → 主题**类型**，更早的存档存的是这个；
 * - 裸的方案 id（`nexus-dark` / `dracula` / …）→ 反查它属于哪个预设的哪一边。
 *
 * 认不出的值原样透传，由 `ThemeManager` 回落 —— 静默改掉会让用户以为选择丢了。
 */
export function normalizeThemeChoice(saved: string | null): string {
  if (!saved || saved === SYSTEM_THEME) return DEFAULT_THEME_CHOICE;
  if (saved === 'dark') return `${DEFAULT_PRESET}${MODE_SEPARATOR}dark`;
  if (saved === 'light') return `${DEFAULT_PRESET}${MODE_SEPARATOR}light`;
  if (saved.includes(MODE_SEPARATOR)) return saved;

  const owner = schemeToPreset.get(saved);
  return owner ? `${owner.preset}${MODE_SEPARATOR}${owner.mode}` : saved;
}

export function parseSelection(choice: string | null): ThemeSelection {
  const raw = normalizeThemeChoice(choice);
  const at = raw.lastIndexOf(MODE_SEPARATOR);
  if (at <= 0) return { id: raw };

  const mode = raw.slice(at + 1);
  return isThemeMode(mode) ? { preset: raw.slice(0, at), mode } : { id: raw };
}

/** 这条选择是否「跟系统走」—— 系统偏好变化时只有它需要重解析。 */
export function isAutoChoice(choice: string | null): boolean {
  const selection = parseSelection(choice);
  return 'preset' in selection && selection.mode === 'auto';
}

/** 选择 + 系统偏好 → 该渲染的主题 id。preload 只拿得到这两样，所以解析必须能在这一步完成。 */
export function resolveThemeId(choice: string | null, prefersDark: boolean): string {
  const selection = parseSelection(choice);
  if ('id' in selection) return selection.id;

  const variants = presetVariants.get(selection.preset);
  if (!variants) return resolveThemeId(DEFAULT_THEME_CHOICE, prefersDark);

  const wanted = selection.mode === 'auto' ? (prefersDark ? 'dark' : 'light') : selection.mode;
  // 单变体预设（上游只有一版）在另一边上没有方案，退回它有的那一边，而不是掉到别的预设。
  const id = variants[wanted] ?? variants.light ?? variants.dark;
  return id ?? resolveThemeId(DEFAULT_THEME_CHOICE, prefersDark);
}

/**
 * 与 `resolveThemeId` 相同，但把认不出的 id 换成默认预设的结果。
 *
 * `isKnown` 由调用方给：preload 只认内置主题，renderer 还认用户主题 —— 注册表不同，但
 * 「认不出就按系统偏好」这条规则必须一致。不一致时 preload 会写一个 renderer 不认的 id，
 * 静态 CSS 匹配不上，于是先按基线画一帧再跳。
 */
export function resolveKnownThemeId(
  choice: string | null,
  prefersDark: boolean,
  isKnown: (id: string) => boolean
): string {
  const id = resolveThemeId(choice, prefersDark);
  return isKnown(id) ? id : resolveThemeId(DEFAULT_THEME_CHOICE, prefersDark);
}

/**
 * 查一个预设有哪些变体。内置预设在 `presetVariants` 里有；**用户主题只有运行时才知道**，
 * 所以由调用方注入（`ThemeManager.userVariantsOf`）。
 */
export type VariantLookup = (presetId: string) => { light?: unknown; dark?: unknown } | null;

/**
 * 这条选择能不能换模式。**两边都有方案才换得动** —— 单变体预设（上游只出一版，如 `dracula`）
 * 与单边用户主题都换不动，换到另一边只会被 `resolveThemeId` 退回原处。
 *
 * 界面据此**禁用**模式控件，而不是让它按下去跳到别的预设 —— 那等于把用户正在编辑的主题丢掉。
 */
export function canChangeMode(choice: string | null, userVariants?: VariantLookup): boolean {
  const selection = parseSelection(choice);
  if (!('preset' in selection)) return false;
  const variants =
    presetVariants.get(selection.preset) ?? userVariants?.(selection.preset) ?? undefined;
  return Boolean(variants?.light && variants?.dark);
}

/**
 * 换模式、保留预设。**换不动时原样返回**（见 `canChangeMode`）—— 静默跳到默认预设等于把用户的
 * 主题丢掉，而「按了没反应」至少是可解释的。
 */
export function choiceWithMode(choice: string | null, mode: ThemeMode): string {
  const selection = parseSelection(choice);
  if ('id' in selection) return selection.id;
  return formatSelection({ preset: selection.preset, mode });
}
