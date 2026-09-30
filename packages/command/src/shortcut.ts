/**
 * 快捷键的解析、格式化、匹配与捕获。内部统一用 CodeMirror 风格的规格串（`Mod-` = macOS Cmd /
 * 其他平台 Ctrl）。
 *
 * **规格串是唯一的交换格式**：存档里存它、菜单显示由它格式化、按下时由它匹配。多一层
 * 「描述符对象」当中间态只会让「存进去的和比对的不是同一个东西」这类 bug 有地方藏。
 *
 * 三处容易写错的判据：
 * 1. `Mod` 与 `Ctrl` / `Meta` **互斥** —— 平台决定 `Mod` 落在哪个物理键上，所以显式写了 `Mod`
 *    就只看那一个键，不再看另一个。两个都判会让 `Mod-S` 在 Windows 上要求「Ctrl 与 Win 同时按」。
 * 2. **键名大小写不敏感**。按住 Shift 时 `event.key` 是 `'S'`，而规格串里存的是 `'s'`。
 * 3. **裸键（无修饰键）不是快捷键**。放行的话 `a` 这种规格会匹配每一次输入，键盘直接失效。
 */

export interface ShortcutDescriptor {
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  key: string;
}

export interface KeyboardShortcutEvent {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  key: string;
}

const APPLE_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Meta: '⌘',
  Ctrl: '⌃',
  Shift: '⇧',
  Alt: '⌥'
};

/**
 * 按下这些键本身不算一次完整的快捷键 —— 它们只是修饰键。
 *
 * **全小写存放**：规格串里的键名被 `parseShortcut` 统一小写，用原大小写比对会漏掉
 * `Mod-Shift` 这种「末段是修饰键」的串（它会被当成一个叫 `shift` 的键放行）。
 */
const MODIFIER_KEY_NAMES = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'altgraph',
  'capslock',
  'numlock',
  'scrolllock',
  'dead',
  'unidentified'
]);

/** `MODIFIER_KEY_NAMES` 的查询入口。大小写不敏感，两处调用都走它。 */
function isModifierKeyName(key: string): boolean {
  return MODIFIER_KEY_NAMES.has(key.toLowerCase());
}

/** 修饰键的规范书写顺序。**规范形只有一个** —— 冲突检测靠字符串相等，顺序不同就判不出来。 */
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const withUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    withUserAgentData.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function parseShortcut(spec: string): ShortcutDescriptor {
  const parts = spec
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean);

  const descriptor: ShortcutDescriptor = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: ''
  };

  if (parts.length === 0) return descriptor;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const lower = part.toLowerCase();
    if (lower === 'mod') descriptor.mod = true;
    else if (lower === 'ctrl') descriptor.ctrl = true;
    else if (lower === 'alt') descriptor.alt = true;
    else if (lower === 'shift') descriptor.shift = true;
    else if (lower === 'meta') descriptor.meta = true;
  }

  // **只小写单字符**。具名键（`ArrowUp` / `Escape` / `F1`）保留原大小写 —— 统一小写会让
  // `formatShortcut` 显示成 `Alt+arrowup`，而匹配本来就是大小写不敏感的，改大小写只损失显示。
  const last = parts[parts.length - 1]!;
  descriptor.key = last.length === 1 ? last.toLowerCase() : last;
  return descriptor;
}

export function formatShortcut(spec: string | ShortcutDescriptor): string {
  if (typeof spec !== 'string') {
    const parts: string[] = [];
    if (spec.mod) parts.push('Mod');
    if (spec.ctrl) parts.push('Ctrl');
    if (spec.alt) parts.push('Alt');
    if (spec.shift) parts.push('Shift');
    if (spec.meta) parts.push('Meta');
    const displayKey = spec.key.length === 1 ? spec.key.toUpperCase() : spec.key;
    parts.push(displayKey);
    return formatShortcutParts(parts);
  }

  const parts = spec
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean);
  return formatShortcutParts(parts);
}

function formatShortcutParts(parts: string[]): string {
  if (parts.length === 0) return '';

  if (isApplePlatform()) {
    return parts.map((part) => APPLE_SYMBOLS[part] ?? part).join('');
  }

  return parts
    .map((part) => {
      if (part === 'Mod') return 'Ctrl';
      if (part === 'Meta') return 'Win';
      return part;
    })
    .join('+');
}

export function matchesShortcut(
  event: KeyboardShortcutEvent,
  descriptorOrSpec: string | ShortcutDescriptor
): boolean {
  const desc =
    typeof descriptorOrSpec === 'string'
      ? parseShortcut(descriptorOrSpec)
      : descriptorOrSpec;

  const apple = isApplePlatform();
  const eventMod = apple ? Boolean(event.metaKey) : Boolean(event.ctrlKey);

  // Check key match case-insensitively
  if (event.key.toLowerCase() !== desc.key.toLowerCase()) {
    return false;
  }

  // Mod check
  if (Boolean(desc.mod) !== eventMod) {
    return false;
  }

  // Shift check
  if (Boolean(desc.shift) !== Boolean(event.shiftKey)) {
    return false;
  }

  // Alt check
  if (Boolean(desc.alt) !== Boolean(event.altKey)) {
    return false;
  }

  // Explicit ctrl/meta check if mod wasn't the sole spec
  if (!desc.mod) {
    if (Boolean(desc.ctrl) !== Boolean(event.ctrlKey)) {
      return false;
    }
    if (Boolean(desc.meta) !== Boolean(event.metaKey)) {
      return false;
    }
  }

  return true;
}

/**
 * 规格串的**规范形**：`Mod-Ctrl-Alt-Shift-<键>`，键名小写。
 *
 * 用途是**比较**：`'Shift-Mod-s'` 与 `'Mod-S'` 是同一个组合键，但字符串不相等。
 * 冲突检测若用原串比对，用户按规范顺序写就能绕过它。
 *
 * 非法（无修饰键、无键名、只有修饰键）返回 `null` —— 调用方据此拒绝，而不是存一个匹配不上
 * 任何事件的串。
 *
 * **`Mod` 在场时丢掉显式的 `Ctrl` / `Meta`**：`matchesShortcut` 在 `mod` 为真时**根本不看**
 * 这两个位（见那里的 `if (!desc.mod)` 分支），所以 `Mod-Ctrl-s` 与 `Mod-s` 实际匹配的是同一批
 * 事件。不归一的话冲突检测会漏掉一对「字符串不同、行为相同」的绑定。
 *
 * 已知的遗留口径：非 Apple 平台上 `Ctrl-x`（不带 `Mod`）匹配不上任何事件 —— `mod=false` 要求
 * `ctrlKey=false`，而 `ctrl=true` 又要求 `ctrlKey=true`，两者互斥。**不修**：界面上拿不到这种串
 * （捕获路径永远产出 `Mod-`），只有手改 localStorage 才会造出来。真要支持得按平台分支，
 * 而 Apple 上 `Ctrl-x` 是合法且独立的绑定，不能一刀切。
 */
export function normalizeShortcut(spec: string): string | null {
  const descriptor = parseShortcut(spec);
  if (!descriptor.key) return null;
  if (isModifierKeyName(descriptor.key)) return null;
  if (!hasModifier(descriptor)) return null;
  return serializeDescriptor(descriptor);
}

/**
 * 一次 `keydown` → 规格串。**修饰键单独按下返回 `null`**（那不是一次完整输入），
 * 无修饰键的普通按键也返回 `null`（裸键当快捷键会让键盘失效）。
 *
 * 平台映射只在这里判一次：Apple 上 `Cmd` 是 `Mod`、`Ctrl` 是显式的 `Ctrl`；其余平台反过来。
 */
export function shortcutFromEvent(event: KeyboardShortcutEvent & { code?: string }): string | null {
  const rawKey = event.key;
  if (!rawKey || isModifierKeyName(rawKey)) return null;

  const apple = isApplePlatform();
  const mod = apple ? Boolean(event.metaKey) : Boolean(event.ctrlKey);

  const descriptor: ShortcutDescriptor = {
    mod,
    // `Mod` 已经吃掉了那个物理键，显式位就不能再写一遍。写了也不会错（`serializeDescriptor`
    // 会丢掉），但留着会让「规格串里有哪些位」这件事有两种写法。
    ctrl: Boolean(event.ctrlKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    meta: Boolean(event.metaKey),
    key: normalizeEventKey(rawKey)
  };

  if (!hasModifier(descriptor)) return null;
  return serializeDescriptor(descriptor);
}

/**
 * `event.key` → 规格串里那个键名。
 *
 * 单字符（字母 / 数字 / 符号）统一小写：按住 Shift 时 `event.key` 是 `'S'`，而规格串里存
 * `'s'`，匹配是大小写不敏感的 —— 存大写会让 `formatShortcut` 与 `matchesShortcut` 走两条路。
 * 具名键（`Escape` / `ArrowUp` / `F1`）原样保留，它们本来就是那个大小写。
 */
function normalizeEventKey(rawKey: string): string {
  return rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
}

function hasModifier(descriptor: ShortcutDescriptor): boolean {
  return Boolean(
    descriptor.mod || descriptor.ctrl || descriptor.alt || descriptor.shift || descriptor.meta
  );
}

function serializeDescriptor(descriptor: ShortcutDescriptor): string {
  // `Mod` 在场时 `Ctrl` / `Meta` 不参与匹配，序列化时一并丢掉 —— 规范形只留一个。
  const dropExplicitModKey = Boolean(descriptor.mod);
  const parts: string[] = [];
  for (const modifier of MODIFIER_ORDER) {
    if (dropExplicitModKey && (modifier === 'Ctrl' || modifier === 'Meta')) continue;
    if (descriptor[modifier.toLowerCase() as 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta']) {
      parts.push(modifier);
    }
  }
  parts.push(descriptor.key);
  return parts.join('-');
}
