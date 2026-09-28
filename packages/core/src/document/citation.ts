/**
 * 文档引用（Phase 3 / P3-11）：把「PDF 里选中的一段文字」变成可粘进 Markdown 的引用。
 *
 * 蓝图 §11.4 给的形状：
 *
 * ```markdown
 * > DMA controller supports ...
 *
 * [STM32F4 Reference Manual](attachments/stm32.pdf#page=342)
 * ```
 *
 * 两件事刻意分成两个函数：**路径必须相对工作区**（`relativePathFrom`）与
 * **页码锚点必须能被自己的 Viewer 认出来**（`pageAnchorOf` / `parsePageAnchor`）。
 * 拼装（`formatDocumentCitation`）只是把两者放到一起 —— 这样「相对谁」与
 * 「锚点长什么样」各自有单测，改一处不会悄悄影响另一处。
 */

/** 页码锚点的参数名。`#page=342` —— 蓝图 §11.4 定死的形式，大小写不敏感地读。 */
const PAGE_ANCHOR_KEY = 'page';

/**
 * 从链接目标里读出页码锚点；没有或不是正整数时返回 `null`。
 *
 * 只认 `#` 片段（`#page=3`），不认查询串（`?page=3`）：锚点是「文档内的位置」，
 * 查询串是「给服务端的参数」，两者混用会让 `resolveWorkspacePath` 的切分规则
 * 出现第二种解释。片段内允许有别的参数（`#page=3&zoom=100`），因为我们自己
 * 将来可能往锚点里加东西，而读到 `page` 就够用了。
 *
 * 页码从 1 起 —— `#page=0` 返回 `null` 而不是 0，调用方不必再判一次边界。
 */
export function parsePageAnchor(href: string): number | null {
  const hashIndex = href.indexOf('#');
  if (hashIndex < 0) return null;

  for (const part of href.slice(hashIndex + 1).split(/[?&]/)) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).toLowerCase() !== PAGE_ANCHOR_KEY) continue;

    const value = Number(part.slice(separator + 1));
    return Number.isInteger(value) && value >= 1 ? value : null;
  }

  return null;
}

/** 页码 → 锚点片段。页码不是正整数时返回空串（链接仍然有效，只是不定位）。 */
export function pageAnchorOf(page: number): string {
  return Number.isInteger(page) && page >= 1 ? `#${PAGE_ANCHOR_KEY}=${page}` : '';
}

/**
 * 把绝对路径转成相对 `baseDirectory` 的路径（正斜杠）。
 *
 * 跨盘符或 UNC 共享名不同时返回 `null` —— 那种情况下不存在合法的相对路径，
 * 编一个出来只会得到一条点不开的链接。调用方（`formatDocumentCitation`）
 * 退回文件名。
 *
 * 大小写只用于**比较**，输出保留 `targetPath` 的原始大小写：Windows 上
 * `d:/Vault` 与 `D:/vault` 是同一个目录，但用户写进 Markdown 的路径该是磁盘上的样子。
 */
export function relativePathFrom(baseDirectory: string, targetPath: string): string | null {
  const base = splitAbsolutePath(baseDirectory);
  const target = splitAbsolutePath(targetPath);
  if (base === null || target === null) return null;
  if (base.root.toLowerCase() !== target.root.toLowerCase()) return null;

  let common = 0;
  while (common < base.segments.length && common < target.segments.length) {
    const baseSegment = base.segments[common];
    const targetSegment = target.segments[common];
    if (baseSegment === undefined || targetSegment === undefined) break;
    if (baseSegment.toLowerCase() !== targetSegment.toLowerCase()) break;
    common += 1;
  }

  const segments = [
    ...Array<string>(base.segments.length - common).fill('..'),
    ...target.segments.slice(common)
  ];
  // 空结果意味着 target 就是 base 自己 —— 没有可写的相对路径
  return segments.length === 0 ? null : segments.join('/');
}

/** 文件名（含扩展名）。 */
export function fileNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * 链接文字：文件名去扩展名（`stm32.pdf` → `stm32`）。
 *
 * 蓝图 §11.4 的例子里写的是文档标题（`STM32F4 Reference Manual`），
 * 而 Phase 3 拿不到 PDF 的元数据标题 —— 文件名是唯一可靠的来源。
 * 前导点不算扩展名（`.gitignore` 保持原样）。
 */
export function documentTitleOf(filePath: string): string {
  const baseName = fileNameOf(filePath);
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
}

export interface DocumentCitationInput {
  /** 选中的原文 */
  quote: string;
  /** 被引用文档的绝对路径 */
  targetPath: string;
  /** 生成引用的那个 `.md` 所在目录；引用里的路径相对它算 */
  baseDirectory: string;
  /** 被引用的页码 */
  page: number;
  /** 链接文字；缺省用文件名去扩展名 */
  title?: string;
}

/**
 * 拼出一条可直接粘进 Markdown 的引用。
 *
 * 三处细节都是为了让结果**能被自己读回来**：
 * - 引文里的空白**折叠成单个空格**。text layer 的换行是排版产物（`<br>` 与
 *   span 边界都会产出空白），与语义换行无法区分；折平至少是可读的，而
 *   `> a` / `> b` 两行则会假装原文在那里断过行。
 * - 标题里的 `[` `]` 转义 —— 不转义会把链接写坏，且症状是「粘进去之后链接少半截」。
 * - 路径含空格时用 `<...>` 包裹（CommonMark 允许），否则空格会截断链接目标。
 */
export function formatDocumentCitation(input: DocumentCitationInput): string {
  const relativePath = relativePathFrom(input.baseDirectory, input.targetPath);
  const path = relativePath ?? fileNameOf(input.targetPath);
  const target = `${path}${pageAnchorOf(input.page)}`;
  const title = (input.title?.trim() || documentTitleOf(input.targetPath)).replace(
    /[[\]]/g,
    '\\$&'
  );

  const quote = collapseWhitespace(input.quote);
  const lines: string[] = [];
  if (quote.length > 0) lines.push(`> ${quote}`, '');
  lines.push(`[${title}](${target.includes(' ') ? `<${target}>` : target})`);
  return lines.join('\n');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface AbsolutePathParts {
  /** 盘符（`d:`）、UNC 共享（`//host/share`）或 POSIX 根（`/`） */
  readonly root: string;
  readonly segments: readonly string[];
}

/** 拆绝对路径；相对路径与空串返回 `null`（引用只应指向绝对路径）。 */
function splitAbsolutePath(input: string): AbsolutePathParts | null {
  const normalized = input.trim().replace(/\\/g, '/');
  if (normalized.length === 0) return null;

  if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/').filter((segment) => segment.length > 0);
    if (parts.length < 2) return null;
    return { root: `//${parts[0]}/${parts[1]}`, segments: parts.slice(2) };
  }

  const drive = /^([a-z]):\//i.exec(normalized);
  if (drive) {
    return {
      root: `${drive[1]}:`,
      segments: normalized.slice(3).split('/').filter((segment) => segment.length > 0)
    };
  }

  if (normalized.startsWith('/')) {
    return {
      root: '/',
      segments: normalized.slice(1).split('/').filter((segment) => segment.length > 0)
    };
  }

  return null;
}
