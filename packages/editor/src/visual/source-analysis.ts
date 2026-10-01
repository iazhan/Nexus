import { documentTypeForPath, toAssetUrl } from '@nexus/core';
import { EMPTY_WORKSPACE_ASSETS, type WorkspaceAssetEntry } from './state.js';

export function resolveDocumentAssetUrl(
  src: string,
  documentDirectory: string | null | undefined
): string | null {
  if (!src || typeof src !== 'string') return null;
  let trimmed = src.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  if (!documentDirectory) {
    return null;
  }

  try {
    const hashIndex = trimmed.indexOf('#');
    const queryIndex = trimmed.indexOf('?');
    let pathPart = trimmed;
    let fragment = '';

    const firstSep =
      hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);
    if (firstSep !== -1) {
      pathPart = trimmed.slice(0, firstSep);
    }
    // **只保留 `#fragment`，丢弃 `?query`。**
    //
    // 目标路径现在住在 `nexus-asset://ws/?path=<编码后的路径>` 这个查询参数里，
    // 再往 URL 末尾拼一个 `?query`，会被 `URLSearchParams` 当成 path 值的一部分
    // （`path=D:/a.png?raw=true`）→ 主进程按这个名字找文件必然 404，图片变空白。
    // 而图片的 query 在本地文件场景下没有任何语义（那是 GitHub `?raw=true` 那类
    // 写法），fragment 则至少还有 SVG sprite（`icons.svg#home`）的可能，所以留它。
    if (hashIndex !== -1) {
      fragment = trimmed.slice(hashIndex);
    }

    try {
      pathPart = decodeURI(pathPart);
    } catch {
      // ignore malformed URI
    }

    const normBase = documentDirectory.replace(/\\/g, '/');
    const normRel = pathPart.replace(/\\/g, '/');

    const isWindowsAbsolute = /^[a-zA-Z]:/.test(normBase);
    const isPosixAbsolute = normBase.startsWith('/');

    if (!isWindowsAbsolute && !isPosixAbsolute) {
      return null;
    }

    const baseSegments = normBase.split('/').filter(Boolean);
    const relSegments = normRel.split('/').filter(Boolean);

    let resolvedSegments: string[];
    if (normRel.startsWith('/')) {
      if (isWindowsAbsolute) {
        resolvedSegments = [baseSegments[0]!, ...relSegments];
      } else {
        resolvedSegments = [...relSegments];
      }
    } else {
      resolvedSegments = [...baseSegments];
      for (const seg of relSegments) {
        if (seg === '.') {
          continue;
        } else if (seg === '..') {
          if (isWindowsAbsolute && resolvedSegments.length <= 1) {
            continue;
          }
          if (resolvedSegments.length > 0) {
            resolvedSegments.pop();
          }
        } else {
          resolvedSegments.push(seg);
        }
      }
    }

    // 走 `nexus-asset://` 而不是 `file://`：`pnpm dev` 的页面来自
    // `http://localhost:6200`，而 Chromium 不允许 http 页面加载 `file://` 子资源
    // （`Not allowed to load local resource`）—— 那会让 dev 下**所有**内嵌图片
    // 变成空白，而打包产物却正常。这不是 CSP 能修的。详见 `@nexus/core`
    // 的 `asset/url.ts`。
    //
    // URL 形状由 core 提供，editor 不再自己拼 —— 拼 URL 是宿主的职责，
    // 硬编码 `file://` 正是这个 bug 的来源。
    if (isWindowsAbsolute) {
      const drive = resolvedSegments[0]!;
      const rest = resolvedSegments.slice(1).join('/');
      return `${toAssetUrl(`${drive}/${rest}`)}${fragment}`;
    }

    return `${toAssetUrl(`/${resolvedSegments.join('/')}`)}${fragment}`;
  } catch {
    return null;
  }
}

/**
 * 工作区里有没有这个嵌入目标；有就返回那一条。
 *
 * 两档，命中即返回：
 * 1. **工作区根相对**精确匹配 —— `![[学习笔记/硬件/图片/x.png]]` 就是这一档。Obsidian
 *    把 vault 内的完整路径直接写进嵌入，所以这一档必须先试。
 * 2. **文件名兜底** —— `![[x.png]]` 而图不在文档旁边的写法（Obsidian 里最常见）。
 *    target 自带目录时还要求路径后缀吻合，否则 `a/x.png` 会匹配到 `b/x.png`。
 *
 * 第二档命中多个时交给 `pickNearestAsset` —— 不取最近的话，同一篇笔记在两台机器上
 * 可能显示不同的图。
 */
function findWorkspaceAsset(
  target: string,
  assets: readonly WorkspaceAssetEntry[],
  documentDirectory: string | null | undefined
): WorkspaceAssetEntry | null {
  if (assets.length === 0) return null;

  const targetKey = target.toLowerCase();
  const hasDirectory = target.includes('/');
  const baseName = (hasDirectory ? target.slice(target.lastIndexOf('/') + 1) : target).toLowerCase();

  const candidates: WorkspaceAssetEntry[] = [];
  for (const entry of assets) {
    const relativeKey = entry.relative.replace(/\\/g, '/').toLowerCase();
    if (relativeKey === targetKey) return entry;
    if (entry.name.toLowerCase() !== baseName) continue;
    if (hasDirectory && !relativeKey.endsWith('/' + targetKey)) continue;
    candidates.push(entry);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  return pickNearestAsset(candidates, documentDirectory);
}

/**
 * 多个同名候选里取离当前文档最近的那个。
 *
 * 排序键：**同目录优先 → 路径浅的优先 → 字典序**。三段都参与是为了让结果**确定** ——
 * 只按「同目录」排的话，两个都在别处的同名文件谁赢取决于清单顺序，那是随机的。
 *
 * 同目录比较用**绝对路径**：`relative` 是工作区根相对的，拿它跟文档目录（绝对）比永远不等。
 * 大小写折叠与 `toPathKey` 同源 —— 同一路径的多种字符串写法必须先归一（Windows 不区分）。
 */
function pickNearestAsset(
  candidates: readonly WorkspaceAssetEntry[],
  documentDirectory: string | null | undefined
): WorkspaceAssetEntry {
  const docDirKey = documentDirectory
    ? documentDirectory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : null;

  let best = candidates[0]!;
  let bestKey = nearestKey(best, docDirKey);
  for (let index = 1; index < candidates.length; index++) {
    const entry = candidates[index]!;
    const key = nearestKey(entry, docDirKey);
    const order =
      key[0] !== bestKey[0]
        ? key[0] - bestKey[0]
        : key[1] !== bestKey[1]
          ? key[1] - bestKey[1]
          : key[2] < bestKey[2]
            ? -1
            : key[2] > bestKey[2]
              ? 1
              : 0;
    if (order < 0) {
      best = entry;
      bestKey = key;
    }
  }
  return best;
}

function nearestKey(
  entry: WorkspaceAssetEntry,
  docDirKey: string | null
): readonly [number, number, string] {
  const absolute = entry.path.replace(/\\/g, '/');
  const slash = absolute.lastIndexOf('/');
  const directory = slash === -1 ? '' : absolute.slice(0, slash);
  const sameDirectory = docDirKey !== null && directory.toLowerCase() === docDirKey ? 0 : 1;
  const relative = entry.relative.replace(/\\/g, '/');
  return [sameDirectory, relative.split('/').length, relative];
}

/** 嵌入目标归一化：反斜杠转正斜杠、去 `./` 前缀、折叠重复斜杠。 */
function normalizeAssetTarget(target: string): string {
  let normalized = target.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.replace(/\/{2,}/g, '/');
}

/**
 * Obsidian 嵌入 `![[…]]` 的目标解析。
 *
 * **与 `![](…)` 不是同一套规则**，混用不报错，只让图片静默变空白：
 * - `![](…)` 是标准 Markdown，相对**当前文档目录**，只此一档 —— 给它加回退，写出的文档
 *   离开本应用就坏。
 * - `![[…]]` 是 Obsidian 的 vault 内短链接，必须走**回退链**：Obsidian 写出来的是
 *   「全库唯一路径」而不是「相对当前文档的路径」，只有一档就必然解析不到。
 *
 * 三档：
 * 1. 绝对路径 —— 没有回退可言。
 * 2. 工作区清单里的 vault 根相对 / 文件名匹配（见 `findWorkspaceAsset`）。
 * 3. **按文档目录相对兜底** —— 保底档，保证不比「只有文档目录」的旧行为更差：
 *    清单还没递进来、或图尚未进索引时，仍按老规矩拼出地址。
 */
export function resolveWikiEmbedAssetUrl(
  target: string,
  documentDirectory: string | null | undefined,
  assets: readonly WorkspaceAssetEntry[] = EMPTY_WORKSPACE_ASSETS
): string | null {
  const normalized = normalizeAssetTarget(target);
  if (!normalized) return null;

  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
    return resolveDocumentAssetUrl(normalized, documentDirectory);
  }

  const hit = findWorkspaceAsset(normalized, assets, documentDirectory);
  if (hit) {
    return toAssetUrl(hit.path);
  }

  return resolveDocumentAssetUrl(target, documentDirectory);
}

/**
 * Obsidian 嵌入 `![[…]]` 里 `!` 的下标；不是嵌入则返回 `null`。
 *
 * 解析层把 `![[x.png]]` 拆成「文本 `!` + wikilink `[[x.png]]`」两段，**不能**在
 * 解析层把它归成 `image` 节点：序列化器按节点类型回写源码，wikilink 换成 image
 * 会让 `![[x.png]]` 往返成 `![](x.png)`，打开一次文件源文本就被改写。
 * 所以识别只能落在投影层 —— 它只影响显示，不参与往返。
 *
 * `wikiFrom` 是 `[[` 的下标。`\![[…]]` 是转义，不算嵌入。
 */
export function obsidianEmbedStart(source: string, wikiFrom: number): number | null {
  if (wikiFrom < 1 || source[wikiFrom - 1] !== '!') return null;
  if (wikiFrom >= 2 && source[wikiFrom - 2] === '\\') return null;
  return wikiFrom - 1;
}

/**
 * Obsidian 嵌入 `|` 参数的像素宽。
 *
 * 嵌入的 `|` 参数**不是**链接别名，而是尺寸：`|200` 是宽，`|200x300` 是宽×高。
 * 只取宽、丢弃高，让高度按原比例走（按字面设高会把图压扁）。
 * 非数字（Obsidian 里那是无意义的写法）一律忽略，退化成不限宽。
 */
export function parseEmbedWidth(alias: string | undefined): number | null {
  if (!alias) return null;
  const match = /^(\d+)(?:x\d+)?$/.exec(alias.trim());
  return match ? Number(match[1]) : null;
}

/**
 * 嵌入的目标是不是**可显示的图片**。
 *
 * `![[某篇笔记]]`（Obsidian 的笔记嵌入）必须退回链接 widget：我们没有「把另一篇笔记的
 * 正文拼进来」这个能力，而当图片渲染会得到一个坏图标 —— 比一个可点的链接更糟。
 * 判据复用文档白名单（`documentTypeForPath`），不另抄一份扩展名表：抄一份就会漂移。
 */
export function isEmbeddableImage(target: string): boolean {
  return documentTypeForPath(target) === 'image';
}

/**
 * 标记之后是否已经没有内容（含只有空白的情况）。
 *
 * 隐藏标记用的是 replace 型 widget：一旦标记独占该行，行内就不存在可放置 DOM 光标的
 * 文本节点，浏览器会把下一个输入字符落到文档开头，表现为首字符被挤到末尾
 * （例如输入 `- i` 得到 ` i-`、输入 `# h` 得到 ` h#`）。
 * 因此标记独占行时必须保持可见。
 */
export function isMarkerAtLineEnd(lineText: string, markerEnd: number): boolean {
  return lineText.slice(markerEnd).trim().length === 0;
}

/**
 * 链接文字在 raw 中的结束位置（返回 `]` 的下标），找不到返回 -1。
 *
 * 不能用 `raw.indexOf(']')`：链接文字里可以嵌套方括号，例如图片链接
 * `[![alt](img)](url)` 的第一个 `]` 属于内层图片，用 indexOf 会把链接文字截成
 * `![alt`、把 `](img)](url)` 整段当成闭合分隔符隐藏掉。这里按嵌套深度配对。
 */
export function findLinkTextEnd(raw: string): number {
  let depth = 0;
  for (let index = 1; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

/**
 * 引用块标记前缀长度：`>` 每层最多吞掉其后的一个空格/制表符，
 * 其余空格属于代码自身缩进，必须保留（`>     indented` 里 4 个空格是代码内容）。
 */
export function leadingQuoteMarkerLength(lineText: string): number {
  const match = lineText.match(/^[ \t]*(?:>[ \t]?)+/);
  return match ? match[0].length : 0;
}

/** 去掉引用标记后的行文本。 */
export function stripQuoteMarkers(lineText: string): string {
  return lineText.slice(leadingQuoteMarkerLength(lineText));
}

/**
 * `pos` 所在行的行首。
 *
 * 行中的图片在揭示态下要把预览提到**行首**：块级预览插在节点原位会把这一行劈开
 * （图片前那截文字被挤到上一行、源码与后面的文字落到下一行）。提到行首之后整行源码
 * 保持完整、预览贴在它上方；图片本来就独占一行时行首就是节点自身，行为不变 ——
 * 所以这是同一套规则，不是两种模式。
 *
 * 只看 `\n`：CRLF 的 `\r` 属于上一行末尾，不影响行首位置。
 */
export function lineStartAt(source: string, pos: number): number {
  return source.lastIndexOf('\n', pos - 1) + 1;
}

/**
 * `from` 之前的同一行内容是否只有引用标记。
 *
 * 引用块内的代码块 raw 只有首行不带 `>`、其余行带（`"```ts\n> code\n> ```"`），
 * 所以判断「是否位于引用块内」不能只看节点自身文本，必须回看文档前缀。
 */
export function isInsideQuotePrefix(source: string, from: number): boolean {
  return /^[ \t]*(?:>[ \t]*)+$/.test(source.slice(lineStartAt(source, from), from));
}

/**
 * raw 首行是否带围栏起始。
 *
 * 用于区分「围栏代码块」与「缩进式代码块」：后者没有围栏行，
 * 不能挂 header/exit widget，但仍应作为代码块渲染出行号与代码样式。
 */
export function hasFenceOpener(raw: string, isQuoteNested: boolean): boolean {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const text = isQuoteNested ? stripQuoteMarkers(firstLine) : firstLine;
  return /^(`{3,}|~{3,})/.test(text.trim());
}

/**
 * 围栏是否闭合，且兼容引用块内的代码块。
 *
 * `isFenceClosed` 直接检查 raw 首行是否以围栏开头，而引用块内的代码块
 * raw 形如 "```ts\n> code\n> ```"（首行没有 `>`、其余行带），因此会被判为
 * 未闭合而整块退化成原文，既没有行号也没有语法高亮。
 * 这里在引用块场景下逐行剥离引用标记后再判定，
 * 同时保持「未闭合围栏保留原文」的既有语义。
 */
export function isClosedFence(raw: string, isQuoteNested: boolean): boolean {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;

  const normalizeLine = (line: string) =>
    (isQuoteNested ? stripQuoteMarkers(line) : line).trim();
  const opener = normalizeLine(lines[0]!).match(/^(`{3,}|~{3,})/);
  if (!opener) return false;

  const fenceChar = opener[1]![0]!;
  const minLength = opener[1]!.length;
  return new RegExp(`^\\${fenceChar}{${minLength},}$`).test(
    normalizeLine(lines[lines.length - 1]!)
  );
}


