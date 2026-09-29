/**
 * base16 导入 / 导出的**接线**：把「一段文本」变成「已切换的用户主题」，以及反过来。
 *
 * 与组件分开是为了能不起 DOM 直接测 —— 组件那层只负责「从 File 拿文本、把结果画出来」。
 *
 * 两条不可让步的：
 *
 * - **导入的是 16 个种子，不是 token。** 文件里即便带了 token 颜色也一律不采信：采信它等于绕过
 *   派生管线，对比度契约当场失效。所以导入后立刻跑一次 `seedsToTokensWithReport()`，把修正条数
 *   报出去。
 * - **导入后立刻切过去。** 导入了却不切，用户看到的是「什么都没发生」。
 */

import {
  base16Slug,
  newUserThemeId,
  parseBase16,
  seedsToTokensWithReport,
  serializeBase16,
  type Base16Error,
  type Base16Format,
  type UserTheme
} from '@nexus/theme';
import {
  applyThemeChoice,
  applyUserTheme,
  applyVariantScheme,
  themeManager
} from '../platform.js';

export type ImportOutcome =
  | { ok: true; themeId: string; name: string; variant: 'light' | 'dark'; corrections: number }
  | { ok: false; error: Base16Error };

/**
 * 把一段 base16 文本**应用到当前主题上**（而不是另建一套主题）。
 *
 * 与 `importBase16Text` 的分工：那个是「我要换一套主题」，这个是「我要把这套配色填进我手上
 * 这套主题」。编辑器里的粘贴框走这条 —— 它就在 16 个取色器上方，用户期待的是「上面的色块变了」。
 *
 * 落点与补版规则见 `applyVariantScheme`。
 */
export type ApplyOutcome =
  | {
      ok: true;
      themeId: string;
      name: string;
      variant: 'light' | 'dark';
      /** `true` = 这一版是新补的，`false` = 覆盖了已有的一版。文案据此说清发生了什么。 */
      added: boolean;
      corrections: number;
    }
  | { ok: false; error: Base16Error };

export function applyBase16ToCurrentTheme(text: string, fallbackName = 'Imported'): ApplyOutcome {
  const parsed = parseBase16(text, fallbackName);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const applied = applyVariantScheme(parsed.scheme);
  // `applyVariantScheme` 只在「拿不到可写的当前主题」时回 null —— 那等于应用失败，报格式错
  // 是误导，但这里没有更贴切的错误码，且该分支实际不可达（内置主题会被 fork）。
  if (!applied) return { ok: false, error: { code: 'not-a-scheme' } };

  return {
    ok: true,
    themeId: applied.id,
    name: parsed.scheme.name,
    variant: parsed.scheme.variant,
    added: applied.added,
    corrections: seedsToTokensWithReport(parsed.scheme).corrections.length
  };
}

/** 导入前是哪个主题 —— 撤销要回到它。 */
export function currentChoice(): string {
  return themeManager.themeChoice;
}

/**
 * 解析错误 → 文案。**放在这里而不是组件里**：粘贴框与文件导入两处都要它，各写一遍必然漂移
 * （漏掉一个 `code` 就会显示成空白）。
 */
export function base16ErrorText(
  t: (key: string, vars?: Record<string, string>) => string,
  error: Base16Error
): string {
  switch (error.code) {
    case 'empty':
      return t('theme.import.error.empty');
    case 'not-a-scheme':
      return t('theme.import.error.format');
    case 'missing-slots':
      return t('theme.import.error.missing', { slots: error.slots.join(', ') });
    case 'invalid-colour':
      return t('theme.import.error.colour', { slot: error.slot, value: error.value });
  }
}

export function importBase16Text(text: string, fallbackName = 'Imported'): ImportOutcome {
  const parsed = parseBase16(text, fallbackName);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const scheme = parsed.scheme;
  // 一个 base16 文件就是**一版**配色，所以导入出来的是单边用户主题 —— 模式切换对它禁用，
  // 与「从单变体预设复制来的」同一套判据。
  const theme: UserTheme = { id: newUserThemeId(), variants: { [scheme.variant]: scheme } };
  applyUserTheme(theme);

  return {
    ok: true,
    themeId: theme.id,
    name: scheme.name,
    variant: scheme.variant,
    corrections: seedsToTokensWithReport(scheme).corrections.length
  };
}

/** 撤销一次导入：回到导入前的**选择**。导入出来的用户主题留在注册表里不删 —— 它已经落盘过一次，
 *  而注册表本身是会话级的，多留一个不参与解析的条目比多做一次删除安全。 */
export function revertImport(choice: string): void {
  applyThemeChoice(choice);
}

export interface ExportResult {
  fileName: string;
  text: string;
  /** base16 只有 16 个槽位，导出即丢弃 token 覆盖项 —— 数量交给 UI 说出来，不静默丢。 */
  droppedOverrides: number;
}

export function exportActiveTheme(format: Base16Format = 'yaml'): ExportResult | null {
  const scheme = themeManager.activeScheme;
  if (!scheme) return null;

  const extension = format === 'json' ? 'json' : 'yaml';
  return {
    fileName: `${base16Slug(scheme.name)}.${extension}`,
    text: serializeBase16(scheme, format),
    droppedOverrides: Object.keys(themeManager.overrides).length
  };
}
