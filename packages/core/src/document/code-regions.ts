/**
 * 把 Markdown 里的**代码区**认出来，供「按位置改写正文」的功能避开它们。
 *
 * ## 为什么需要它
 *
 * 文档里到处是 `` `[[dma]]` `` 与 ``` ![](assets/x.png) ``` 这样的**例子** ——
 * 回写链接时改到它们，就是把用户写的文档改成错的。少改一处引用是「链接断了但看得见」，
 * 改错一处是「静默改了用户的示例代码」，两个方向的代价不对称。
 *
 * ## 为什么用掩码而不是「按节点递归」
 *
 * 按节点递归需要 parser，而调用它的地方（`apps/desktop/electron/link-rewrite.ts`）是
 * **主进程**：为一次低频的改名把整个 parser（parser + serializer + render-model + security）
 * 拖进主进程的启动路径不划算。
 *
 * ## 为什么不是「正则删掉代码块」
 *
 * 那会让偏移全乱，而回写要的正是偏移 —— 它必须知道每一处在源码里的 `[start, end)`。
 * 掩码是**等长**的：偏移与换行都不变，调用方拿到的分组下标直接就是原文的下标。
 *
 * ## 两个已知取舍
 *
 * - **围栏内的行内代码不再单独处理**（整段已经掩掉了），所以不会出现嵌套问题；
 * - **未闭合的围栏一直掩到文件末尾** —— 与 CommonMark 一致，也是更安全的方向。
 *
 * ## 掩码字符为什么是 `\u0000`
 *
 * 它不可能出现在用户正文里，也不会与 `[` `]` `|` `(` `)` `<` `>` 组成语法。
 * 代价是**调用方必须自己挡住「跨掩码区的假匹配」**：填充字符不匹配 `]` 或 `)`，
 * 但会匹配 `[^\]|]+` 这类否定字符类，于是 `` [[a` `` …（中间整段代码）… `` `]] ``
 * 理论上能被扫出来。判据是一句话：**匹配到的整段里含 `CODE_FILLER` 就丢掉**。
 */

/** 掩码字符。产物里出现它就说明那一段原来是代码。 */
export const CODE_FILLER = '\u0000';

/**
 * 把代码区（围栏代码块 + 行内代码）替换成等长的填充字符，**偏移与换行都不变**。
 */
export function maskCodeRegions(source: string): string {
  const masked = source.split('');

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) masked[index] = CODE_FILLER;
  };

  let offset = 0;
  let fence: { char: string; length: number } | null = null;

  for (const line of source.split('\n')) {
    const lineEnd = offset + line.length;
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fence === null) {
      if (opener) {
        fence = { char: opener[1]![0]!, length: opener[1]!.length };
        blank(offset, lineEnd);
      }
    } else {
      blank(offset, lineEnd);
      if (opener && opener[1]![0] === fence.char && opener[1]!.length >= fence.length) {
        fence = null;
      }
    }

    offset = lineEnd + 1;
  }

  maskInlineCode(masked);
  return masked.join('');
}

/**
 * 掩掉行内代码。**必须在围栏之后做** —— 围栏区已经变成填充字符，这里就只需认反引号，
 * 不会把围栏的 ` ``` ` 当成行内代码的起止符。
 *
 * CommonMark 的规则：起止必须是**等长**的反引号串（`` `a` `` 与 ``` ``a`` ``` 是两回事）。
 * 不等长时继续往后找，找不到就整段不算行内代码。
 */
function maskInlineCode(masked: string[]): void {
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '`') continue;

    const runLength = countBackticks(masked, index);
    let cursor = index + runLength;
    let closing = -1;

    while (cursor < masked.length) {
      if (masked[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      const closingRun = countBackticks(masked, cursor);
      if (closingRun === runLength) {
        closing = cursor;
        break;
      }
      cursor += closingRun;
    }

    if (closing === -1) {
      index += runLength - 1;
      continue;
    }

    for (let at = index; at < closing + runLength; at += 1) masked[at] = CODE_FILLER;
    index = closing + runLength - 1;
  }
}

/** 从 `start` 起连续反引号的个数。 */
function countBackticks(masked: readonly string[], start: number): number {
  let length = 0;
  while (masked[start + length] === '`') length += 1;
  return length;
}
