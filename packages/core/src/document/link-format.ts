import { documentTitleOf, fileNameOf, relativePathFrom } from './citation.js';
import { isMarkdownPath } from './extensions.js';

/**
 * 往正文里写一条链接时，用哪种写法。
 *
 * 三档而不是 Obsidian 的「是否用 Wikilink + 路径格式三选一」两维相乘：Nexus 的
 * **Markdown 链接侧不存在「绝对路径」这一档**（见下），两维相乘里有一格是空的，
 * 而一个「选了也不对」的档比少一档更糟。理由写在 `buildDocumentLink` 上。
 *
 * 取值就是存档里的字符串，所以**改了会让存量存档落回默认**（`parseLinkFormat` 认不出
 * 就回落），与 `DeleteMode` 同一类契约。
 */
export type LinkFormat = 'wikilink' | 'wikilink-path' | 'markdown';

export const LINK_FORMAT_WIKILINK: LinkFormat = 'wikilink';
export const LINK_FORMAT_WIKILINK_PATH: LinkFormat = 'wikilink-path';
export const LINK_FORMAT_MARKDOWN: LinkFormat = 'markdown';

/**
 * 全部取值，**顺序即设置页里的顺序**。
 *
 * 由「最简」到「最啰嗦」：只写名字 → 写工作区根相对路径 → 换成 Markdown 链接。
 * 后两档都能解决「同名文档不止一篇」的问题，但代价依次变大（前者仍在 wikilink 里，
 * 后者换掉了整条链接的语法）。
 */
export const LINK_FORMATS: readonly LinkFormat[] = [
  LINK_FORMAT_WIKILINK,
  LINK_FORMAT_WIKILINK_PATH,
  LINK_FORMAT_MARKDOWN
];

/**
 * 默认档 —— **等于加这一项之前的观感**。
 *
 * 加这一项之前，编辑器里唯一一条「往正文写链接」的路是 `/` 片段面板里的
 * `[[${page}]]`（`packages/editor/src/completions.ts`，boost 8，是链接类里最高的一个），
 * 写出来的就是「只写名字」这一档。默认值取它，装上这一版不该让老用户的链接写法变样。
 */
export const LINK_FORMAT_DEFAULT: LinkFormat = LINK_FORMAT_WIKILINK;

/**
 * 写链接时需要的、关于目标文档的全部事实。
 *
 * 只有两个字段，且都是 `IndexedDocument` 上现成的 —— 刻意不收整个 `IndexedDocument`：
 * 这个函数是纯字符串运算，不该认识 `contentHash` / `modifiedAtMs` 那些东西，
 * 否则测起来要先编一份完整的索引行。
 */
export interface LinkTargetDocument {
  /** 绝对路径（`IndexedDocument.path`）。Markdown 档要拿它算相对路径。 */
  path: string;
  /** 工作区根相对路径，正斜杠（`IndexedDocument.relativePath`）。wikilink 路径档用它。 */
  relativePath: string;
}

/**
 * 写不出来的三种情形。调用方**必须**把它翻成给用户看的话 —— 静默什么都不做，
 * 用户会以为「这个菜单项是摆设」（与 `copyText` 返回 `false` 要报错同一条纪律）。
 */
export type LinkBuildFailure =
  /** 没有打开的文档，Markdown 档的「相对谁」没有基准。 */
  | 'no-current-document'
  /** 目标与当前文档不在同一卷，不存在合法的相对路径。 */
  | 'not-in-workspace'
  /** 名字里有 wikilink 语法表达不了的字符。 */
  | 'unescapable-name';

export type LinkBuildResult =
  | { ok: true; text: string }
  | { ok: false; reason: LinkBuildFailure };

/**
 * 把「指向某篇文档的链接」拼成一段可以直接粘进正文的文本。
 *
 * ## 它是 `resolveWikiLink` 的逆运算，所以住在同一个包里
 *
 * 写出来的东西**必须能被自己读回来** —— 这是这一对函数唯一的契约，也是它单测里
 * 最要紧的一条（把产物喂回 `resolveWikiLink` / `resolveRelativePath`，断言落到同一篇）。
 * 批二把 `resolveWikiLink` 从 renderer 搬进 core 就是「两处各写一份必然漂」那条教训；
 * 这次是同一件事的另一半：**正反两个方向分居两个包，漂起来没人能发现**。
 *
 * ## 两种格式的路径基准**不一样**，这是最容易写错的一处
 *
 * | 格式 | 路径相对谁 | 谁解析 |
 * | --- | --- | --- |
 * | `[[notes/dma]]` | **工作区根** | `resolveWikiLink`（`wikilink.ts`） |
 * | `[dma](notes/dma.md)` | **当前文档所在目录** | `resolveRelativePath`（`link-navigation.ts`） |
 *
 * 所以同一篇目标文档，从 `a/` 下的文档引用与从 `b/` 下引用，**Markdown 档写出来的
 * 路径不同**（`../notes/dma.md` vs `notes/dma.md`），而 wikilink 档相同。
 * 推论：Markdown 档必须有 `currentDocumentPath`，只给目标是不够的。
 *
 * ## 为什么没有「绝对路径」这一档
 *
 * `resolveRelativePath` 把**前导 `/` 解释成「相对当前文档目录」**，而且注释里写明这是
 * 刻意的（「本编辑器没有仓库根的概念，这是最贴近用户预期的一种」）。所以照搬 Obsidian
 * 的三档时，给 Markdown 链接提供「绝对路径」会写出一条**指向别处且不报错**的链接。
 * 要么整档不做，要么只对 wikilink 生效 —— 这里选前者，理由见 `LinkFormat` 的注释。
 *
 * ## 名字里写不了的字符
 *
 * - **wikilink 侧没有转义机制**：`]` 会让链接提前结束、`|` 会被当成别名分隔符、
 *   `#` 会被当成锚点起点。三种都只能放弃（返回 `unescapable-name`）。
 *   这与批二的 `rewriteWikiLinkTarget` 是同一条纪律：宁可让链接断掉（那是**可见**的
 *   `not-found`），也不要写出一段语法坏掉的正文。
 * - **Markdown 侧有转义**：文字里的 `[` `]` 加反斜杠（照 `formatDocumentCitation`），
 *   路径含空格或括号时用 `<...>` 包裹（CommonMark 允许，`marked` 解析时会剥掉）。
 *   所以这一档的失败面小得多，只有「不在同一卷」那一种。
 */
export function buildDocumentLink(
  target: LinkTargetDocument,
  format: LinkFormat,
  currentDocumentPath: string | null
): LinkBuildResult {
  const relativePath = normalizeSlashes(target.relativePath);
  const markdown = isMarkdownPath(target.path);

  if (format === LINK_FORMAT_MARKDOWN) {
    const baseDirectory = currentDocumentPath === null ? null : directoryOf(currentDocumentPath);
    if (baseDirectory === null) return { ok: false, reason: 'no-current-document' };

    const relative = relativePathFrom(baseDirectory, target.path);
    if (relative === null) return { ok: false, reason: 'not-in-workspace' };

    const text = linkTextOf(target.path).replace(/[[\]]/g, '\\$&');
    return { ok: true, text: `[${text}](${needsAngleBrackets(relative) ? `<${relative}>` : relative})` };
  }

  // wikilink 的两档：区别只在「要不要带上工作区根相对路径」。
  const written =
    format === LINK_FORMAT_WIKILINK_PATH ? wikilinkTargetOf(relativePath, markdown) : wikilinkNameOf(target.path, markdown);
  if (!isExpressibleAsWikilink(written)) return { ok: false, reason: 'unescapable-name' };

  return { ok: true, text: `[[${written}]]` };
}

/**
 * 解析存档里的取值，**认不出就回落默认档**。
 *
 * 与 `parseDeleteMode` / `parseHistoryRetention` 同一条：值要拿去查表，所以必须收窄到一个
 * 合法档位。方向与「会删数据的项」相反是刻意的 —— 那类项认不出要往「不做」那侧倒，
 * 这一项只是写链接的写法，回落到默认（＝加这一项之前的观感）就是最保守的落点。
 */
export function parseLinkFormat(raw: string | null | undefined): LinkFormat {
  return LINK_FORMATS.includes(raw as LinkFormat) ? (raw as LinkFormat) : LINK_FORMAT_DEFAULT;
}

/**
 * wikilink 里写的「名字」（不带目录）。
 *
 * Markdown 去扩展名（`resolveWikiLink` 的候选表会自己试 `.md` / `.markdown`），
 * 附件**保留全名** —— `[[stm32]]` 在 `stm32.md` 也存在时会归 `.md`（候选顺序是契约，
 * 见 `wikilink.ts`），写全名才是唯一能精确指向附件的方式。
 */
function wikilinkNameOf(path: string, markdown: boolean): string {
  const base = fileNameOf(path);
  return markdown ? documentTitleOf(base) : base;
}

/**
 * wikilink 里写的「工作区根相对路径」。
 *
 * 与 `wikilinkNameOf` 同一套去扩展名规则，只是作用在路径上。**不能直接用
 * `documentTitleOf`** —— 它只吃文件名，喂整条路径进去会把目录一起切掉
 * （`notes/v1.2.md` → `v1.2`，`notes/` 没了），所以按最后一段切、目录原样接回去。
 */
function wikilinkTargetOf(relativePath: string, markdown: boolean): string {
  if (!markdown) return relativePath;
  const slash = relativePath.lastIndexOf('/');
  return slash < 0
    ? documentTitleOf(relativePath)
    : relativePath.slice(0, slash + 1) + documentTitleOf(relativePath);
}

/** Markdown 链接的文字。与 wikilink 侧同一条「Markdown 去扩展名、附件留全名」的规则。 */
function linkTextOf(path: string): string {
  return isMarkdownPath(path) ? documentTitleOf(path) : fileNameOf(path);
}

/**
 * wikilink 语法表达不了的字符。
 *
 * 控制字符单独按码点判（`no-control-regex` 不让把 `\u0000-\u001f` 写进字符组，
 * 先例见 `settings/preference-specs.ts` 与 `document/attachments.ts`）。
 */
const WIKILINK_FORBIDDEN = /[[\]|#]/;

function isExpressibleAsWikilink(target: string): boolean {
  if (WIKILINK_FORBIDDEN.test(target)) return false;
  for (const char of target) {
    if (char.charCodeAt(0) <= 0x1f) return false;
  }
  return true;
}

/**
 * 路径要不要用 `<...>` 包起来。
 *
 * 空格是 `formatDocumentCitation` 已经处理过的那一种（`> a` 那样的引用文字里空格会
 * 截断目标）；这里多判括号与尖括号 —— CommonMark 允许目标里出现**配对**的括号，
 * 但不成对时链接会当场坏掉，而文件名里出现单个括号太容易了。
 */
function needsAngleBrackets(relativePath: string): boolean {
  return /[ ()<>]/.test(relativePath);
}

/** 绝对路径的目录；没有分隔符（`note.md` 这种裸名字）时返回 `null`。 */
function directoryOf(filePath: string): string | null {
  const normalized = normalizeSlashes(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? null : normalized.slice(0, slash);
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
