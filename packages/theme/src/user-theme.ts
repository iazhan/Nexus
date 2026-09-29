/**
 * 用户主题：一套**自定义预设** —— 明暗两版可写副本 + 它的序列化。
 *
 * 三条判据：
 *
 * - **id 必须是 `user:` 前缀**。内置 id 被写成用户主题的话，「切回 Nexus Light」得到的是改过的
 *   Nexus Light，用户没有退路。校验放在这里而不是调用方 —— 存档是用户能改的，唯一权威就是解析。
 * - **必需的部分严格、可选的部分宽松**：两版各自 16 个槽位缺一不可（缺了只能猜，猜出来的配色
 *   用户看不懂为什么是这样），`tuning` 与 `overrides` 里坏掉的项丢掉即可 —— 它们本来就是
 *   「在默认之上」。
 * - **明暗两版放在同一个用户主题里**，而不是两个用户主题：它们共用模式轴，用户在设置页切
 *   「浅色 / 深色」切的是同一套主题的两版。两版共用一个名字（`name` 存在各自的 scheme 里，
 *   由 `ThemeManager` 里唯一的写入口保持相等）。
 *
 * 上游只有一版的族（如 dracula）fork 出来就只有一边，模式控件对它禁用 —— 与单变体内置预设
 * 同一套判据（`canChangeMode`）。
 *
 * 带 `version` 是为了格式变更有个出口：读到更高的版本号直接拒收，不猜。**旧存档的迁移全在
 * `parseUserThemes` 里**（v1 `{ id, scheme }` 单版 → v2 `{ id, variants }` 两版 → v3
 * `{ themes: [...] }` 列表），三种形状都读得回来，用户装过的主题不会因为升级而消失。
 */

import { parseColour } from './contrast.js';
import { BASE16_SLOTS, type Base16Slot, type NexusThemeScheme, type Tuning } from './seeds.js';

export const USER_THEME_PREFIX = 'user:';

const FORMAT_VERSION = 3;

/** 用户主题能装的两版。与 `NexusThemeScheme['variant']` 同域。 */
export type ThemeVariant = 'light' | 'dark';

export interface UserTheme {
  /** `user:<uuid>`。同时是它的**预设 id** —— 选择写成 `<id>@<模式>`。 */
  id: string;
  /** 至少有一边。空的那边表示这套主题没有该模式（模式控件对它禁用）。 */
  variants: { light?: NexusThemeScheme; dark?: NexusThemeScheme };
}

export function isUserThemeId(id: string): boolean {
  return id.startsWith(USER_THEME_PREFIX) && id.length > USER_THEME_PREFIX.length;
}

export function newUserThemeId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return USER_THEME_PREFIX + uuid;
}

/**
 * 这套主题有的变体，顺序恒为 light → dark。
 *
 * 顺序固定而不是按对象键序：它决定设置页模式卡片的排布与「两版都有」的判定，跟着键序走会让
 * 同一份数据在不同引擎上表现不同。
 */
export function userThemeVariants(theme: UserTheme): ThemeVariant[] {
  return (['light', 'dark'] as const).filter((variant) => Boolean(theme.variants[variant]));
}

/**
 * 主题的显示名。两版共用同一个名字（写入口保持相等），所以取哪一边都一样 ——
 * 只有一边时自然取那一边。
 */
export function userThemeName(theme: UserTheme): string {
  return theme.variants.light?.name ?? theme.variants.dark?.name ?? '';
}

/**
 * 「同一套主题」的基名：去掉结尾的模式词。`Ayu Dark` → `Ayu`，`Solarized Light` → `Solarized`。
 *
 * 用来判断两套用户主题能不能合并 —— 上游的 base16 仓库把明暗两版命名成 `Ayu Dark` / `Ayu Light`，
 * 那正是「同一套主题的两面」，而它们会各自被导入成一套单边用户主题。
 *
 * 整名就是一个模式词时（有人真把主题叫 `Dark`）原样返回 —— 剥成空串会让所有这类名字互相当成
 * 同一套主题。
 */
export function userThemeBaseName(name: string): string {
  return name.replace(/\s*[-–—]?\s*(light|dark)\s*$/i, '').trim() || name;
}

/**
 * 找一个能跟 `theme` 合并的**另一套**用户主题：基名相同、变体**不重叠**、且对方至少有一版。
 *
 * 变体不重叠是硬条件 —— 两边都有浅色时合并必然丢掉一份，而丢哪一份没有好答案。
 * 返回 `null` 表示没有候选，调用方据此不画提示。
 */
export function userThemeMergeTarget(
  theme: UserTheme,
  others: readonly UserTheme[]
): UserTheme | null {
  const mine = userThemeBaseName(userThemeName(theme)).toLowerCase();
  if (mine === '') return null;

  for (const other of others) {
    if (other.id === theme.id) continue;
    if (userThemeVariants(other).length === 0) continue;
    if (userThemeBaseName(userThemeName(other)).toLowerCase() !== mine) continue;
    const overlaps = userThemeVariants(theme).some((variant) => Boolean(other.variants[variant]));
    if (overlaps) continue;
    return other;
  }
  return null;
}

/**
 * 把 `source` 并进 `target`：取并集，**同一边冲突时保留 `target` 的**。
 *
 * 名字也一并归一到 `target` 的 —— 合并出来的是一套主题，两版该共用一个名字。调用方负责先问过
 * 用户（这是个不可逆的合并：被并掉的那套会从列表里消失）。
 */
export function mergeUserThemes(target: UserTheme, source: UserTheme): UserTheme {
  const name = userThemeName(target) || userThemeName(source);
  const variants = { ...source.variants, ...target.variants };
  return {
    id: target.id,
    variants: {
      ...(variants.light ? { light: { ...variants.light, name } } : {}),
      ...(variants.dark ? { dark: { ...variants.dark, name } } : {})
    }
  };
}

export function serializeUserTheme(theme: UserTheme): string {
  return JSON.stringify({ version: FORMAT_VERSION, id: theme.id, variants: theme.variants });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isColour = (value: unknown): value is string =>
  typeof value === 'string' && parseColour(value) !== null;

/** 坏项丢掉，不拒整份 —— 见文件头「可选的部分宽松」。 */
function readTuning(value: unknown): Tuning | undefined {
  if (!isRecord(value)) return undefined;
  const out: Tuning = {};
  const keys: readonly (keyof Tuning)[] = [
    'surfaceHover',
    'surfaceActive',
    'quote',
    'borderSubtle',
    'borderStrong'
  ];
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readOverrides(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [token, colour] of Object.entries(value)) {
    if (isColour(colour)) out[token] = colour;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readPalette(value: unknown): Record<Base16Slot, string> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<Base16Slot, string>;
  for (const slot of BASE16_SLOTS) {
    if (!isColour(value[slot])) return null;
    out[slot] = value[slot] as string;
  }
  return out;
}

function readScheme(value: unknown): NexusThemeScheme | null {
  if (!isRecord(value)) return null;
  const palette = readPalette(value.palette);
  if (!palette) return null;
  if (typeof value.name !== 'string' || value.name === '') return null;
  if (value.variant !== 'light' && value.variant !== 'dark') return null;

  const tuning = readTuning(value.tuning);
  const overrides = readOverrides(value.overrides);
  return {
    name: value.name,
    variant: value.variant,
    palette,
    ...(typeof value.author === 'string' ? { author: value.author } : {}),
    ...(tuning ? { tuning } : {}),
    ...(overrides ? { overrides } : {})
  };
}

/**
 * 两版一起读。**一边坏掉就整份拒收**，不静默丢掉那一边 —— 丢了一边用户会以为它还在，
 * 而实际上「深色那版」已经没了。
 */
function readVariants(value: unknown): UserTheme['variants'] | null {
  if (!isRecord(value)) return null;

  const light = value.light === undefined ? undefined : readScheme(value.light);
  const dark = value.dark === undefined ? undefined : readScheme(value.dark);
  if (value.light !== undefined && !light) return null;
  if (value.dark !== undefined && !dark) return null;
  if (!light && !dark) return null;

  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
}

/**
 * 存档字符串 → 用户主题。**任何坏数据都回落 `null`，不抛** —— 这个函数挂在 `SettingDef.parse`
 * 上，读初值时抛错会白屏。
 *
 * v1（`{ id, scheme }`，单版）按 scheme 自己的 `variant` 归到对应那一边。判据用「有没有
 * `variants` 字段」而不是版本号：更早的存档里 `version` 可能缺失。
 */
export function parseUserTheme(raw: string | null): UserTheme | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return readUserTheme(parsed);
}

/**
 * 存档字符串 → 用户主题**列表**。
 *
 * 三种形状都吃，靠这一条完成迁移：
 * - **数组**（手写过的存档）→ 逐项读；
 * - `{ themes: [...] }`（v3，当前格式）→ 逐项读；
 * - **单个对象**（v1 / v2：那时存档里只有一套）→ 包成单元素数组。
 *
 * 坏项**丢掉而不是拒整份**：这是「读一份存档」，一份里坏了一条不该让其余几套主题一起消失。
 * 与 `parseUserTheme` 的「拒整份」不同 —— 那里一份就是一套主题，丢掉它等于没读。
 */
export function parseUserThemes(raw: string | null): UserTheme[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.themes)
      ? parsed.themes
      : [parsed];

  const out: UserTheme[] = [];
  for (const item of items) {
    const theme = readUserTheme(item);
    // 同 id 只留第一份：存档被手改出重复 id 时，后一份会让「哪份生效」变得不可预测。
    if (theme && !out.some((existing) => existing.id === theme.id)) out.push(theme);
  }
  return out;
}

export function serializeUserThemes(themes: readonly UserTheme[]): string {
  return JSON.stringify({ version: FORMAT_VERSION, themes });
}

function readUserTheme(parsed: unknown): UserTheme | null {
  if (!isRecord(parsed)) return null;
  const version = parsed.version;
  if (version !== undefined && (typeof version !== 'number' || version > FORMAT_VERSION)) return null;
  if (typeof parsed.id !== 'string' || !isUserThemeId(parsed.id)) return null;

  if (parsed.variants !== undefined) {
    const variants = readVariants(parsed.variants);
    return variants ? { id: parsed.id, variants } : null;
  }

  const scheme = readScheme(parsed.scheme);
  return scheme ? { id: parsed.id, variants: { [scheme.variant]: scheme } } : null;
}
