/**
 * 字素簇（grapheme cluster）工具 —— **一个「用户看到的字符」不等于一个 UTF-16 码元**。
 *
 * ## 为什么需要这一层
 *
 * `String.prototype.slice` / `.length` 数的是 UTF-16 码元。两处后果：
 *
 * - **emoji 与罕见汉字**（U+1F600、U+20BB7）占两个码元，从中间切开留下一个**孤立代理项**，
 *   屏幕上就是一个 `�`；
 * - **组合字符**（`e` + U+0301 = `é`）、带 ZWJ 的家族 emoji、带肤色修饰的 emoji 更极端：
 *   一个「用户看到的字符」可以有十几个码元，按码元数切会把一个字符切散成几块。
 *
 * 所以：任何**按长度截断**都要按字素簇数，任何**从中间取一段**都要先把下标对齐到字素簇边界。
 * 目前两个消费者：图谱标签的宽度截断（`graph-labels.ts`）与提及摘录的取窗（`mentions.ts`）。
 *
 * ## 无 `Intl.Segmenter` 时退化成「按码点」
 *
 * 老 Chromium 与精简 ICU 的 Node 里没有 `Intl.Segmenter`。那时退到码点级：
 * **仍然不会**切开代理对（判据「输出里没有孤立代理项」照旧成立），但会把
 * `é`（`e` + 组合符）这类切成两半。宁可粗一点，不能抛异常 —— 这段代码在
 * 「画一个标签」「算一条提及」的路径上，抛出去就是整块图谱不画 / 整个面板空掉。
 *
 * 这也是参考实现（`open-knowledge` 的 `grapheme-clip.ts`）做过的同一件事，理由相同。
 */

/**
 * 分词器在**模块加载时**取一次。
 *
 * 不在每次调用里查：`Intl.Segmenter` 的构造有开销，而这个模块的调用点在绘制循环里
 * （每帧、每个标签一次）。代价是测试要验「没有 Segmenter」那一支时必须
 * `vi.resetModules()` 再动态 `import` —— 那条用例本来也得这么做才诚实。
 */
const SEGMENTER: Intl.Segmenter | null = (() => {
  const Ctor = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl?.Segmenter;
  return Ctor === undefined ? null : new Ctor(undefined, { granularity: 'grapheme' });
})();

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 把一个字符串切成字素簇（每个元素是「一个用户看到的字符」）。
 *
 * 用数组而不是迭代器：调用方要**从后往前**取（截断时优先保前部），
 * 一次性切开比每次重扫一遍省事。标签与摘录都很短，内存不是问题。
 */
export function segmentGraphemes(text: string): string[] {
  if (SEGMENTER === null) return Array.from(text);
  const clusters: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) clusters.push(segment);
  return clusters;
}

/**
 * 把下标**收回到**它所在字素簇的起点（下标本来就在边界上时原样返回）。
 *
 * 用于「一段区间的开头」：宁可少要一个字符，也不能从半个字符开始。
 */
export function graphemeBoundaryAtOrBefore(text: string, index: number): number {
  if (SEGMENTER === null) {
    // 退化成码点级：下标落在代理对的后半（低代理）时退回一格
    return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
      ? index - 1
      : index;
  }
  const segment = SEGMENTER.segment(text).containing(index);
  return segment === undefined ? index : segment.index;
}

/**
 * 把下标**推到**它所在字素簇的末尾之后（下标本来就在边界上时原样返回）。
 *
 * 用于「一段区间的结尾」：宁可多要一个字符，也不能在半个字符处收尾。
 */
export function graphemeBoundaryAtOrAfter(text: string, index: number): number {
  if (SEGMENTER === null) {
    return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
      ? index + 1
      : index;
  }
  const segment = SEGMENTER.segment(text).containing(index);
  if (segment === undefined || segment.index === index) return index;
  return segment.index + segment.segment.length;
}
