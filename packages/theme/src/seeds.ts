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

/**
 * 三套第三方预设。**值逐字取自 tinted-theming 的 `spec-0.11` 方案文件，不手调** ——
 * 手调过的预设既不是上游的、也不是我们的，而「上游那套长什么样」正是用户导入它的理由。
 * 槽位语义与 base16 规范一致（base00 背景 → base07 最亮/最暗的前景），所以派生管线的
 * 灰阶方向判断直接可用。
 *
 * 唯一保留的差异是**大小写**：上游写 `#2E3440`，这里落成小写 —— 与既有两套同形，
 * 也让 `base16.ts` 的往返测试能逐字符比对。
 */
export const draculaSeeds: NexusThemeScheme = {
  name: 'Dracula',
  author: 'clach04',
  variant: 'dark',
  palette: {
    base00: '#282a36', base01: '#21222c', base02: '#44475a', base03: '#6272a4',
    base04: '#9ea8c7', base05: '#f8f8f2', base06: '#f8f8f2', base07: '#ffffff',
    base08: '#ff5555', base09: '#ffb86c', base0A: '#f1fa8c', base0B: '#50fa7b',
    base0C: '#8be9fd', base0D: '#bd93f9', base0E: '#ff79c6', base0F: '#993333',
  },
};

export const nordSeeds: NexusThemeScheme = {
  name: 'Nord',
  author: 'arcticicestudio',
  variant: 'dark',
  palette: {
    base00: '#2e3440', base01: '#3b4252', base02: '#434c5e', base03: '#4c566a',
    base04: '#d8dee9', base05: '#e5e9f0', base06: '#eceff4', base07: '#8fbcbb',
    base08: '#bf616a', base09: '#d08770', base0A: '#ebcb8b', base0B: '#a3be8c',
    base0C: '#88c0d0', base0D: '#81a1c1', base0E: '#b48ead', base0F: '#5e81ac',
  },
};

export const tokyoNightSeeds: NexusThemeScheme = {
  name: 'Tokyo Night Dark',
  author: 'Michaël Ball',
  variant: 'dark',
  palette: {
    base00: '#1a1b26', base01: '#16161e', base02: '#2f3549', base03: '#444b6a',
    base04: '#787c99', base05: '#a9b1d6', base06: '#cbccd1', base07: '#d5d6db',
    base08: '#c0caf5', base09: '#a9b1d6', base0A: '#0db9d7', base0B: '#9ece6a',
    base0C: '#b4f9f8', base0D: '#2ac3de', base0E: '#bb9af7', base0F: '#f7768e',
  },
};

/**
 * 出厂主题表：**id 与种子成对写在这里**，`index.ts` 直接消费。
 *
 * id 放在种子旁边而不是 `index.ts` 里 —— id 在两处各写一遍迟早对不上，而「哪几套随产品出厂」
 * 是种子层的事实。用户主题不走这张表（它们的 id 由 `user-theme.ts` 生成）。
 */
export const BUILT_IN_SCHEMES: readonly { id: string; scheme: NexusThemeScheme }[] = [
  { id: 'nexus-light', scheme: nexusLightSeeds },
  { id: 'nexus-dark', scheme: nexusDarkSeeds },
  { id: 'dracula', scheme: draculaSeeds },
  { id: 'nord', scheme: nordSeeds },
  { id: 'tokyo-night-dark', scheme: tokyoNightSeeds },
];
