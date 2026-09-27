/**
 * 绝对路径 → `file://` URL。
 *
 * 图片是唯一走 `file://` 的资源（§10.4 定案 A：`nexus-asset://` 留给需要 Range
 * 的 PDF / DOCX），而 `<img src>` 只认 URL。renderer 跑在沙箱里，拿不到
 * `node:url` 的 `pathToFileURL`，所以这个转换只能自己写 —— 那就必须写对：
 *
 * - **按段 `encodeURIComponent`，不能用 `encodeURI`。** 后者**不转义** `#` 与 `?`，
 *   而这两个在 Windows 文件名里都合法：`图#1.png` 会被浏览器读成
 *   「路径 `图` + 锚点 `1.png`」→ 图片加载不出来，而界面上只有「加载失败」，
 *   看不出是转义问题。
 * - **盘符的冒号必须还原。** `encodeURIComponent('D:')` 得到 `D%3A`，
 *   URL 就成了 `file:///D%3A/...`，浏览器会把它当成相对路径 —— 同样加载不出来。
 * - **反斜杠先归一化。** `D:\a\b.png` 与 `D:/a/b.png` 必须得到同一个 URL，
 *   否则同一张图会因为路径来源不同（索引 vs 拖放）而只有一条能显示。
 *
 * 与 Node 的 `pathToFileURL` 逐例对照过（见 `file-url.test.ts`）：`#` `?` `%`
 * 空格 中文 全部逐字节一致。`+ ~ & =` 这几个会转义得比 Node **更保守**
 * （`+` → `%2B`，`~` 保持原样），解码后是同一个文件名，不影响正确性 ——
 * 所以不为了对齐 Node 的字节输出而复刻它的白名单。
 *
 * **前提：入参是绝对路径。** 相对路径会得到 `file:///相对路径`，语义不是
 * 「相对当前目录」；调用方不要依赖它。UNC 路径（`\\server\share`）不在支持范围内 ——
 * 本应用的工作区根一直是本地盘符路径。
 */
export function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');

  if (DRIVE_PREFIX.test(normalized)) {
    // 用 `slice` / `replace` 而不是正则分组：`noUncheckedIndexedAccess` 下
    // `match[1]` 是 `string | undefined`，要抹平它就得写断言或 `?? ''`，
    // 而这两者都会掩盖「正则改坏了」这个错误。这两个 API 的返回类型里
    // 没有 undefined，不需要兜底。
    const driveLetter = normalized.slice(0, 1);
    return `file:///${driveLetter}:/${encodeSegments(normalized.replace(DRIVE_PREFIX, ''))}`;
  }

  return `file:///${encodeSegments(normalized.replace(/^\/+/, ''))}`;
}

/** 盘符前缀（`D:/`、`c://`）。只用来判定与剥离，不取分组。 */
const DRIVE_PREFIX = /^[A-Za-z]:\/+/;

/**
 * 逐段转义。
 *
 * 整串 `encodeURIComponent` 会把分隔用的 `/` 也转成 `%2F`，那就不再是路径了。
 */
function encodeSegments(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
