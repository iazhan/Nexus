/**
 * 内置主题 → 静态 CSS。
 *
 * 只写 `data-theme` 而没有 CSS 消费它等于没写：preload 在 9.6ms 就落属性，但那时 renderer 还没跑、
 * `<style id="nexus-theme-vars">` 还不存在。所以内置主题的变量必须在**构建期**落成文件，且由
 * `<link>` 引入（走 JS import 的 CSS 是运行时注入，晚于首帧）。`:root` 与基线主题合成一块 ——
 * 没有 `data-theme` 或 id 认不出时退化成基线，而不是「一个变量都没有」。
 */

import { SYSTEM_DEFAULTS } from './resolve.js';
import type { ThemeDefinition } from './index.js';

const HEADER = `/* 生成物，不要手改 —— 由 packages/theme/scripts/generate-css.mjs
   从 packages/theme/src/index.ts 的 BUILT_IN_THEMES 写出。 */

`;

/**
 * `baselineId` 的主题同时挂在 `:root` 上，作为「认不出 id」时的兜底。
 *
 * 具体度：`html[data-theme='x']` 是 (0,1,1)，`:root` 是 (0,1,0) —— 所以有合法 id 时属性选择器
 * 一定赢，基线只在没有属性或属性认不出时生效。
 */
export function themesToCss(
  themes: readonly ThemeDefinition[],
  baselineId: string = SYSTEM_DEFAULTS.light
): string {
  if (!themes.some((theme) => theme.id === baselineId)) {
    throw new Error(`themesToCss: 基线主题 ${baselineId} 不在 themes 里`);
  }

  const blocks = themes.map((theme) => {
    const selector =
      theme.id === baselineId
        ? `:root,\nhtml[data-theme='${theme.id}']`
        : `html[data-theme='${theme.id}']`;
    const declarations = Object.entries(theme.tokens).map(
      ([token, value]) => `  --nexus-${token}: ${value};`
    );
    return `${selector} {\n${declarations.join('\n')}\n}`;
  });

  return HEADER + blocks.join('\n\n') + '\n';
}
