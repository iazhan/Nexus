/**
 * 快捷键定义与转换：内部统一使用 CodeMirror 风格（`Mod-` = macOS Cmd / 其他平台 Ctrl）。
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

  descriptor.key = parts[parts.length - 1]!.toLowerCase();
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
