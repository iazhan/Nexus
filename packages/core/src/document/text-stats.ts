/**
 * 文档字数统计。
 *
 * **「字数」= 非空白字符数**，中英文一视同仁。中文没有词边界，按「词」统计要先分词，
 * 而不同工具对同一份中文稿给出的词数能差一倍 —— 字符数没有这个歧义，也和「我写了多少字」
 * 这个直觉对得上。
 *
 * 空白一律不计：空格、制表符、换行都不算，否则一个空行密集的文档会比同样内容多出几百字。
 * 判据用 `\s` 而不是手写空格列表，它覆盖全角空格（U+3000）与各类换行符。
 *
 * **Markdown 语法字符（`#`、`*`、`[]` 等）计入。** 统计跑在 source 上，剥掉语法等于在猜
 * 渲染结果，而渲染是可变的（主题、扩展都会改它）。宁可把 `#` 也算上，也不给一个会随
 * 渲染设置跳动的数字。
 *
 * 按**码点**迭代而不是 `.length`：`.length` 是 UTF-16 单元数，一个 emoji 会算成两个字。
 */
const WHITESPACE = /\s/;

export function countDocumentCharacters(source: string): number {
  let count = 0;
  for (const char of source) {
    if (!WHITESPACE.test(char)) count += 1;
  }
  return count;
}
