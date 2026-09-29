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
import { applyThemeChoice, applyUserTheme, themeManager } from '../platform.js';

export type ImportOutcome =
  | { ok: true; themeId: string; name: string; variant: 'light' | 'dark'; corrections: number }
  | { ok: false; error: Base16Error };

/** 导入前是哪个主题 —— 撤销要回到它。 */
export function currentChoice(): string {
  return themeManager.themeChoice;
}

export function importBase16Text(text: string, fallbackName = 'Imported'): ImportOutcome {
  const parsed = parseBase16(text, fallbackName);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const scheme = parsed.scheme;
  const theme: UserTheme = { id: newUserThemeId(), scheme };
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
