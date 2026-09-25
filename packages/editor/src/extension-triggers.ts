import type { MarkdownMarker } from './types.js';

/**
 * 懒加载扩展的 id。
 *
 * 注册方（`App.tsx`）要能在**不 import 扩展包**的前提下说出「我要登记谁」，
 * 所以 id 和触发谓词一起放在这里；扩展实现反过来引用它，
 * 同一个字符串不会在两处各写一遍。
 */
export const MATH_EXTENSION_ID = 'nexus-math';
export const MERMAID_EXTENSION_ID = 'nexus-mermaid';

/**
 * 扩展触发谓词 —— 懒加载的**唯一判定源**。
 *
 * 为什么必须住在 editor 包而不是扩展包：懒加载要求「在扩展包被 import 之前」就能判断
 * 某个 marker 归谁。谓词若写在 `@nexus/math` 里，为了拿到它就得先 import 那个包，
 * katex（481KB + 一整套字体与 CSS）和 mermaid（2.3MB）立刻被拉进主包，懒加载当场失效。
 *
 * 扩展自己的 `canHandle` 必须调用这里，不允许再写第二份判断 ——
 * 双判定是本仓库已经踩过的坑（`markdown-markers.ts` 的独立扫描器 vs AST）。
 */
export function isMathMarker(marker: MarkdownMarker): boolean {
  return marker.type === 'inline-math' || marker.type === 'block-math';
}

/**
 * 「这个围栏信息串是 mermaid 吗」—— 与 `code-block.ts` 的预览判定共用一个实现。
 *
 * 必须一起处理 `trim()` 与大小写：CommonMark 的 info string 会被去空白，
 * ` ```Mermaid ` 和 ` ``` mermaid ` 都是合法写法。原先 `code-block.ts` 里写的是
 * `this.language === 'mermaid'`（大小写敏感、不 trim），与本文件的谓词不一致 ——
 * 结果是大写写法的文档会把 1.2MB 的 mermaid 包拉下来，却因为预览判定不成立而什么都不显示。
 * 双判定是本仓库已经踩过的坑，这里只留一份。
 *
 * 不复用 `code-highlight.ts` 的 `normalizeLanguage`：那个模块静态 import 了一整套
 * CM 语言包，而本模块要能在不拉任何重依赖的前提下求值。
 * `LANGUAGE_ALIASES` 里没有 mermaid 别名，所以 lower/trim 已足够。
 */
export function isMermaidLanguage(language: string | undefined): boolean {
  return language?.trim().toLowerCase() === 'mermaid';
}

export function isMermaidMarker(marker: MarkdownMarker): boolean {
  return marker.type === 'code-fence' && isMermaidLanguage(marker.language);
}
