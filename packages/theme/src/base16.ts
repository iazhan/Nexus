/**
 * base16 方案的读与写。base16 是**种子层**的交换格式 —— 只有 16 个槽位，没有 `tuning`、
 * 没有 token 覆盖项。所以「导入一份 base16」= 换掉 16 个种子，之后一切照走派生管线。
 *
 * 两种形状都收，因为 tinted-theming 自己跨规范版本换过形状：
 *
 * - **扁平**（spec ≤ 0.10）：`scheme: "Dracula"` + 顶层 `base00: "..."`。
 * - **嵌套**（spec 0.11 起）：`name: "Dracula"` + `variant: dark` + `palette:` 下缩进的 16 行。
 *
 * JSON 收同样两种（`palette` 嵌套或顶层直铺）。
 *
 * 三处刻意的严格：
 *
 * - **16 个槽位缺一不可**，缺了报出**具体槽位名**。用默认值补上会让用户导入一个灰扑扑的主题、
 *   而且不知道为什么 —— 灰扑扑正是「缺的槽位被填成同一个颜色」的样子。
 * - **色值必须是 hex**，`rgb()` / 具名色一律拒收。base16 规范就是 hex，收下别的等于自己造方言。
 * - **`variant` 显式优先，缺省才推断**。推断依据是「base00 比 base05 暗 → 暗色」——
 *   base16 里 base00 是背景、base05 是正文，这个方向是规范定的，不是猜的。
 *
 * 错误以**结构化 code** 返回而不是文案：本包不依赖 i18n，措辞由调用方决定。
 */

import { parseColour, relativeLuminance } from './contrast.js';
import { BASE16_SLOTS, type Base16Slot } from './seeds.js';

export interface Base16Scheme {
  name: string;
  author?: string;
  variant: 'light' | 'dark';
  palette: Record<Base16Slot, string>;
}

export type Base16Error =
  | { code: 'empty' }
  | { code: 'not-a-scheme' }
  | { code: 'missing-slots'; slots: readonly Base16Slot[] }
  | { code: 'invalid-colour'; slot: Base16Slot; value: string };

export type Base16ParseResult =
  | { ok: true; scheme: Base16Scheme }
  | { ok: false; error: Base16Error };

export type Base16Format = 'yaml' | 'json';

const SLOT_RE = /^base[0-9a-fA-F]{2}$/;

/** 归一化成 `#rrggbb` 小写。3 位写法展开，8 位丢掉 alpha（种子层不该带透明度）。 */
function normalizeColour(raw: string): string | null {
  const value = raw.trim();
  const hex = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (!hex) return null;

  let digits = hex[1] as string;
  if (digits.length === 3 || digits.length === 4) {
    digits = [...digits].map((char) => char + char).join('');
  }
  if (digits.length === 8) digits = digits.slice(0, 6);
  return `#${digits.toLowerCase()}`;
}

function isSlot(key: string): key is Base16Slot {
  return SLOT_RE.test(key) && (BASE16_SLOTS as readonly string[]).includes(key);
}

/** base00 比 base05 暗 → 暗色。两者无法解析时按亮色，宁可猜错方向也不要抛在推断这一步。 */
export function inferVariant(palette: Record<string, string>): 'light' | 'dark' {
  const background = parseColour(palette.base00 ?? '');
  const foreground = parseColour(palette.base05 ?? '');
  if (!background || !foreground) return 'light';
  return relativeLuminance(background) < relativeLuminance(foreground) ? 'dark' : 'light';
}

function toScheme(
  record: Record<string, unknown>,
  fallbackName: string
): Base16ParseResult {
  // 嵌套形状把 16 个槽位放在 `palette` 下；扁平形状直接铺在顶层。
  const nested = record.palette;
  const source = (typeof nested === 'object' && nested !== null ? nested : record) as Record<
    string,
    unknown
  >;

  const raw: Partial<Record<Base16Slot, string>> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isSlot(key) || typeof value !== 'string') continue;
    raw[key] = value;
  }

  const missing = BASE16_SLOTS.filter((slot) => raw[slot] === undefined);
  if (missing.length > 0) return { ok: false, error: { code: 'missing-slots', slots: missing } };

  const palette = {} as Record<Base16Slot, string>;
  for (const slot of BASE16_SLOTS) {
    const original = raw[slot] as string;
    const colour = normalizeColour(original);
    if (!colour) return { ok: false, error: { code: 'invalid-colour', slot, value: original } };
    palette[slot] = colour;
  }

  const name =
    typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : typeof record.scheme === 'string' && record.scheme.trim()
        ? record.scheme.trim()
        : fallbackName;

  const author =
    typeof record.author === 'string' && record.author.trim() ? record.author.trim() : undefined;

  const declared = record.variant;
  const variant =
    declared === 'light' || declared === 'dark' ? declared : inferVariant(palette);

  return { ok: true, scheme: { name, author, variant, palette } };
}

/** 剥掉 YAML 行尾注释。`#` 只有**在引号外且前面是空白**时才是注释 —— 色值本身以 `#` 开头。 */
function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * 只认「扁平键值 + 一层 `palette:` 缩进」这一种 YAML —— 也就是 base16 方案实际发布的形状。
 * 不引 YAML 库：为 20 行扁平数据拉一个解析器（以及它带来的锚点 / 多文档 / 类型推断语义）
 * 不划算，而这里拒收嵌套结构是**显式**的（非 `palette` 的嵌套块被跳过，槽位随之报缺失）。
 */
function parseYaml(text: string, fallbackName: string): Base16ParseResult {
  const record: Record<string, unknown> = {};
  const palette: Record<string, string> = {};
  let inPalette = false;
  let sawPalette = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine);
    if (!line.trim()) continue;

    const indented = /^\s/.test(line);
    const body = line.trim();
    const at = body.indexOf(':');
    if (at <= 0) continue;

    const key = body.slice(0, at).trim();
    const value = unquote(body.slice(at + 1));

    if (key === 'palette' && !value) {
      inPalette = true;
      sawPalette = true;
      continue;
    }
    // 非 `palette` 的顶层键会把我们从 palette 块里带出来。
    if (!indented) inPalette = false;

    if (inPalette && indented) {
      palette[key] = value;
      continue;
    }
    if (value) record[key] = value;
  }

  if (sawPalette) record.palette = palette;
  return toScheme(record, fallbackName);
}

/** 认字符串是 JSON 还是 YAML：base16 的 JSON 一定以 `{` 起头，YAML 一定不是。 */
export function parseBase16(text: string, fallbackName = 'Imported'): Base16ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: { code: 'empty' } };

  // 只有以 `{` / `[` 起头的才当 JSON 解 —— base16 的 JSON 形状是对象，YAML 一定不是。
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: { code: 'not-a-scheme' } };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: { code: 'not-a-scheme' } };
    }
    return toScheme(parsed as Record<string, unknown>, fallbackName);
  }

  return parseYaml(trimmed, fallbackName);
}

const quoted = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/** 写 spec 0.11 的嵌套形状 —— 那是当前规范，扁平形状只为了读老文件而保留。 */
export function serializeBase16(scheme: Base16Scheme, format: Base16Format = 'yaml'): string {
  if (format === 'json') {
    const payload = {
      system: 'base16',
      name: scheme.name,
      ...(scheme.author ? { author: scheme.author } : {}),
      variant: scheme.variant,
      palette: Object.fromEntries(BASE16_SLOTS.map((slot) => [slot, scheme.palette[slot]]))
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  const lines = ['system: "base16"', `name: ${quoted(scheme.name)}`];
  if (scheme.author) lines.push(`author: ${quoted(scheme.author)}`);
  lines.push(`variant: ${quoted(scheme.variant)}`, 'palette:');
  for (const slot of BASE16_SLOTS) lines.push(`  ${slot}: "${scheme.palette[slot]}"`);
  return `${lines.join('\n')}\n`;
}

/** 文件名用的 slug。导出时要有个稳定的名字，`Dracula Theme` → `dracula-theme`。 */
export function base16Slug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'theme';
}
