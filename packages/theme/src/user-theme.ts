/**
 * 用户主题：内置主题的可写副本 + 它的序列化。
 *
 * 两条判据：
 *
 * - **id 必须是 `user:` 前缀**。内置 id 被写成用户主题的话，「切回 Nexus Light」得到的是改过的
 *   Nexus Light，用户没有退路。校验放在这里而不是调用方 —— 存档是用户能改的，唯一权威就是解析。
 * - **必需的部分严格、可选的部分宽松**：16 个槽位缺一不可（缺了只能猜，猜出来的配色用户看不懂
 *   为什么是这样），`tuning` 与 `overrides` 里坏掉的项丢掉即可 —— 它们本来就是「在默认之上」。
 *
 * 带 `version` 是为了将来格式变更有个出口：读到更高的版本号直接拒收，不猜。
 */

import { parseColour } from './contrast.js';
import { BASE16_SLOTS, type Base16Slot, type NexusThemeScheme, type Tuning } from './seeds.js';

export const USER_THEME_PREFIX = 'user:';

const FORMAT_VERSION = 1;

export interface UserTheme {
  /** `user:<uuid>`。 */
  id: string;
  /** 完整快照（含 `overrides`）—— 不存「基底 id + 差异」，内置配色改了用户主题不跟着变，这是对的。 */
  scheme: NexusThemeScheme;
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

export function serializeUserTheme(theme: UserTheme): string {
  return JSON.stringify({ version: FORMAT_VERSION, id: theme.id, scheme: theme.scheme });
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
 * 存档字符串 → 用户主题。**任何坏数据都回落 `null`，不抛** —— 这个函数挂在 `SettingDef.parse`
 * 上，读初值时抛错会白屏。
 */
export function parseUserTheme(raw: string | null): UserTheme | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const version = parsed.version;
  if (version !== undefined && (typeof version !== 'number' || version > FORMAT_VERSION)) return null;
  if (typeof parsed.id !== 'string' || !isUserThemeId(parsed.id)) return null;

  const scheme = readScheme(parsed.scheme);
  return scheme ? { id: parsed.id, scheme } : null;
}
