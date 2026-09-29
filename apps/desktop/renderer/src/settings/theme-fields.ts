/**
 * 主题编辑器的**数据表**：哪些种子、哪些系数、43 个 token 怎么分组。
 *
 * 只放数据，不放视图 —— 分组表同时被「高级档渲染」与「分组覆盖完整性测试」读，两处各列一遍
 * 必然漂移（漏一个 token 不会有任何东西报错，只会在界面上少一行）。
 *
 * **token 的标签就是 token 名本身**（`bg-surface`），不进字典：高级档是给愿意读 CSS 变量的人用
 * 的，`--nexus-bg-surface` 比任何译名都准确，而且不会随翻译漂移。
 */

import type { Base16Slot, Tuning } from '@nexus/theme';

export interface SeedGroup {
  id: 'grayscale' | 'accent';
  labelKey: string;
  slots: readonly Base16Slot[];
}

/** 灰阶决定背景与正文，强调色决定语法与状态 —— 与 `seeds.ts` 的槽位注释同一套分法。 */
export const SEED_GROUPS: readonly SeedGroup[] = [
  {
    id: 'grayscale',
    labelKey: 'theme.seeds.grayscale',
    slots: ['base00', 'base01', 'base02', 'base03', 'base04', 'base05', 'base06', 'base07']
  },
  {
    id: 'accent',
    labelKey: 'theme.seeds.accent',
    slots: ['base08', 'base09', 'base0A', 'base0B', 'base0C', 'base0D', 'base0E', 'base0F']
  }
];

/** 槽位 → 它主要喂给什么。取色器只有色块时，用户不知道动它会改到哪里。 */
export const SLOT_ROLE_KEYS: Record<Base16Slot, string> = {
  base00: 'theme.slot.base00',
  base01: 'theme.slot.base01',
  base02: 'theme.slot.base02',
  base03: 'theme.slot.base03',
  base04: 'theme.slot.base04',
  base05: 'theme.slot.base05',
  base06: 'theme.slot.base06',
  base07: 'theme.slot.base07',
  base08: 'theme.slot.base08',
  base09: 'theme.slot.base09',
  base0A: 'theme.slot.base0A',
  base0B: 'theme.slot.base0B',
  base0C: 'theme.slot.base0C',
  base0D: 'theme.slot.base0D',
  base0E: 'theme.slot.base0E',
  base0F: 'theme.slot.base0F'
};

export interface TuningField {
  key: keyof Required<Tuning>;
  labelKey: string;
  min: number;
  max: number;
  step: number;
}

/**
 * 五个系数都是「朝某个槽位混合的比例」，所以值域是 0–1。上限按各自的观感收窄：hover 超过 0.4
 * 就不再像 hover 而是像选中。
 */
export const TUNING_FIELDS: readonly TuningField[] = [
  { key: 'surfaceHover', labelKey: 'theme.tuning.surfaceHover', min: 0, max: 0.4, step: 0.01 },
  { key: 'surfaceActive', labelKey: 'theme.tuning.surfaceActive', min: 0, max: 0.5, step: 0.01 },
  { key: 'quote', labelKey: 'theme.tuning.quote', min: 0, max: 0.5, step: 0.01 },
  { key: 'borderSubtle', labelKey: 'theme.tuning.borderSubtle', min: 0, max: 1, step: 0.01 },
  { key: 'borderStrong', labelKey: 'theme.tuning.borderStrong', min: 0, max: 1, step: 0.01 }
];

export interface TokenGroup {
  id: 'surface' | 'text' | 'accent' | 'syntax' | 'markdown';
  labelKey: string;
  tokens: readonly string[];
}

const SYNTAX_HIGHLIGHT_TOKENS: readonly string[] = [
  'syntax-heading',
  'syntax-keyword',
  'syntax-control',
  'syntax-module',
  'syntax-string',
  'syntax-comment',
  'syntax-number',
  'syntax-bool',
  'syntax-function',
  'syntax-variable',
  'syntax-property',
  'syntax-type',
  'syntax-operator',
  'syntax-punctuation',
  'syntax-builtin',
  'syntax-url'
];

/** 43 个 token 分五组，**不重不漏**由测试守着。 */
export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'surface',
    labelKey: 'theme.group.surface',
    tokens: [
      'bg-canvas',
      'bg-surface',
      'bg-surface-hover',
      'bg-surface-active',
      'bg-quote',
      'syntax-inline-code-bg',
      'status-warning-bg',
      'status-error-bg',
      'selection-bg'
    ]
  },
  {
    id: 'text',
    labelKey: 'theme.group.text',
    tokens: ['text-primary', 'text-secondary', 'text-muted', 'accent-text', 'accent-contrast']
  },
  {
    id: 'accent',
    labelKey: 'theme.group.accent',
    tokens: ['accent-indicator', 'accent-solid', 'accent-solid-hover']
  },
  {
    id: 'syntax',
    labelKey: 'theme.group.syntax',
    tokens: SYNTAX_HIGHLIGHT_TOKENS
  },
  {
    id: 'markdown',
    labelKey: 'theme.group.markdown',
    tokens: [
      'syntax-inline-code-text',
      'border-subtle',
      'border-default',
      'border-strong',
      'status-success-text',
      'status-warning-text',
      'status-error-text',
      'status-success-border',
      'status-warning-border',
      'status-error-border'
    ]
  }
];

export const ALL_EDITABLE_TOKENS: readonly string[] = TOKEN_GROUPS.flatMap((group) => group.tokens);

/** 取色器的兜底值 —— 不是主题色，只是给 `??` 一个类型安全的落点。 */
export const COLOUR_FALLBACK = '#000000'; // @constant 取色器兜底值，与主题无关

/**
 * `<input type="color">` 只吃 `#rrggbb`。种子里可能出现 3 / 4 / 8 位写法（`parseColour` 都认），
 * 半透明的 token（`selection-bg` 是 `rgba()`）更是直接不合法 —— 不归一化的话取色器会显示成黑色，
 * 用户一动它就把那个 token 换成不透明的颜色。
 *
 * **8 位十六进制的 alpha 会被丢掉**：取色器没有透明度通道，这是它的能力边界；丢掉是显式的，
 * 用户看得见结果。
 *
 * `rgb()` 的通道允许带负号（CSS 会把它夹到 0）—— 正则不认负号的话下面那个 `Math.max(0, …)`
 * 就是死代码，而看起来像有保护。
 */
export function toColorInputValue(value: string): string {
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim());
  if (!hex) {
    const fn = /^rgba?\(\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(-?\d+)/.exec(value.trim());
    if (!fn) return COLOUR_FALLBACK;
    const channel = (raw: string): string =>
      Math.max(0, Math.min(255, Number(raw))).toString(16).padStart(2, '0');
    return `#${channel(fn[1] as string)}${channel(fn[2] as string)}${channel(fn[3] as string)}`;
  }

  let digits = hex[1] as string;
  if (digits.length === 3 || digits.length === 4) {
    digits = [...digits].map((char) => char + char).join('');
  }
  if (digits.length === 8) digits = digits.slice(0, 6);
  if (digits.length !== 6) return COLOUR_FALLBACK;
  return `#${digits.toLowerCase()}`;
}
