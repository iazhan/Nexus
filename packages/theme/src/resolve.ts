/**
 * 主题**选择**与**解析**分开：存档存选择（`system` 或 id），渲染用解析结果 id。合成一个的话，
 * 跟随系统时写回存档会把 `system` 覆盖成具体 id，跟随当场丢失。preload 与 renderer 共用
 * （不碰 DOM），两边解析不一致会「先按 A 画一帧、起来再跳 B」。
 */

/** 存档键。与 `platform.ts`、`preload/theme-boot.ts` 必须一致。 */
export const THEME_STORAGE_KEY = 'nexus-theme';

/** 「跟随系统」在存档里的哨兵值。 */
export const SYSTEM_THEME = 'system';

/** 跟随系统时用的内置主题对。内置预设改数据驱动后，这里换成按 `variant` 查表。 */
export const SYSTEM_DEFAULTS: Record<'light' | 'dark', string> = {
  light: 'nexus-light',
  dark: 'nexus-dark'
};

/**
 * 旧存档存的是主题**类型**，现在存主题 id。迁移垫片，与 `ThemeManager` 读旧值同源（有测试锁着
 * 一致），等存档都迁完才能删。
 */
const LEGACY_TYPE_IDS: Record<string, string> = {
  dark: 'nexus-dark',
  light: 'nexus-light'
};

/** 主题类型 → 该类型的内置主题 id。 */
export function themeIdForType(type: 'light' | 'dark'): string {
  return SYSTEM_DEFAULTS[type];
}

/** 存档值 → 选择。缺省即「跟随系统」（与既有行为一致）；认不出的值原样透传，由 `ThemeManager` 回落。 */
export function normalizeThemeChoice(saved: string | null): string {
  if (!saved) return SYSTEM_THEME;
  return LEGACY_TYPE_IDS[saved] ?? saved;
}

/** 选择 + 系统偏好 → 该渲染的主题 id。preload 只拿得到这两样，所以解析必须能在这一步完成。 */
export function resolveThemeId(choice: string | null, prefersDark: boolean): string {
  const normalized = normalizeThemeChoice(choice);
  if (normalized === SYSTEM_THEME) return SYSTEM_DEFAULTS[prefersDark ? 'dark' : 'light'];
  return normalized;
}

/**
 * 与 `resolveThemeId` 相同，但把认不出的 id 换成跟随系统的结果。
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
  return isKnown(id) ? id : SYSTEM_DEFAULTS[prefersDark ? 'dark' : 'light'];
}
