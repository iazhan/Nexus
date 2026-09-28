/**
 * 16 色种子。值不是设计出来的，是从既有手写值反推的：每个槽位取该色相簇里承担最多 token
 * 的值，`palette` 每行的尾注就是依据。
 *
 * 既有配色是三套色板拼装，共用 9–10 个色相而 base16 只给 7 个槽位，必然有 token 被折到
 * 邻近色相。灰阶方向随 variant 反转：light 是 base00 最亮 → base07 最暗，dark 相反。
 *
 * `tuning` 的五个系数都是「朝某个槽位混合的比例」，留空表示用缺省值。
 */

export type Base16Slot =
  | 'base00' | 'base01' | 'base02' | 'base03'
  | 'base04' | 'base05' | 'base06' | 'base07'
  | 'base08' | 'base09' | 'base0A' | 'base0B'
  | 'base0C' | 'base0D' | 'base0E' | 'base0F';

export const BASE16_SLOTS: readonly Base16Slot[] = [
  'base00', 'base01', 'base02', 'base03',
  'base04', 'base05', 'base06', 'base07',
  'base08', 'base09', 'base0A', 'base0B',
  'base0C', 'base0D', 'base0E', 'base0F',
];

export interface Tuning {
  surfaceHover?: number;
  surfaceActive?: number;
  quote?: number;
  borderSubtle?: number;
  borderStrong?: number;
}

export interface NexusThemeScheme {
  name: string;
  author?: string;
  variant: 'light' | 'dark';
  palette: Record<Base16Slot, string>;
  tuning?: Tuning;
  /**
   * token 名（**不带** `--nexus-` 前缀）→ 值。在 `seedsToTokens()` **之后**覆盖，且不参与对比度
   * 修正 —— 用户明确要这个值，修正它等于骗人（不达标要在 UI 上标出来）。混进派生循环会让覆盖值
   * 参与修正，语义完全不同。
   *
   * 与 `palette` 一起序列化：导出用户主题时两者都要带上，缺了覆盖项导出的就是另一套配色。
   */
  overrides?: Record<string, string>;
}

export const nexusLightSeeds: NexusThemeScheme = {
  name: 'Nexus Light',
  variant: 'light',
  palette: {
    base00: '#ffffff', // bg-canvas
    base01: '#f3f3f3', // bg-surface
    base02: '#d4d4d4', // border-default
    base03: '#999999', // text-muted
    base04: '#666666', // text-secondary
    base05: '#333333', // text-primary
    base06: '#1a1a1a', // 预留（05 与 07 之间）
    base07: '#000000', // syntax-heading / syntax-operator
    base08: '#a31515', // syntax-string、status-error-*
    base09: '#92400e', // status-warning-text
    base0A: '#fbbf24', // status-warning-border / -bg
    base0B: '#008000', // syntax-comment、syntax-number、status-success-*
    base0C: '#267f99', // syntax-type
    base0D: '#007acc', // accent-*、syntax-url、syntax-keyword、syntax-variable
    base0E: '#af00db', // syntax-control / syntax-module
    base0F: '#795e26', // syntax-function
  },
};

export const nexusDarkSeeds: NexusThemeScheme = {
  name: 'Nexus Dark',
  variant: 'dark',
  palette: {
    base00: '#1e1e1e', // bg-canvas
    base01: '#252526', // bg-surface
    base02: '#3c3c3c', // border-default
    base03: '#666666', // text-muted
    base04: '#888888', // text-secondary
    base05: '#cccccc', // text-primary
    base06: '#e0e0e0', // 预留
    base07: '#ffffff', // syntax-heading
    base08: '#f87171', // status-error-*
    base09: '#ce9178', // syntax-string
    base0A: '#fbbf24', // status-warning-*
    base0B: '#6a9955', // syntax-comment、syntax-number
    base0C: '#4ec9b0', // syntax-type / syntax-builtin、status-success-*
    base0D: '#4daafc', // accent-*、syntax-url、syntax-keyword、syntax-variable
    base0E: '#c586c0', // syntax-control / syntax-module
    base0F: '#dcdcaa', // syntax-function
  },
};

export const BUILT_IN_SCHEMES: readonly NexusThemeScheme[] = [nexusLightSeeds, nexusDarkSeeds];
