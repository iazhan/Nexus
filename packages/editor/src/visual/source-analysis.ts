import { toAssetUrl } from '@nexus/core';

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
 * `from` 之前的同一行内容是否只有引用标记。
 *
 * 引用块内的代码块 raw 只有首行不带 `>`、其余行带（`"```ts\n> code\n> ```"`），
 * 所以判断「是否位于引用块内」不能只看节点自身文本，必须回看文档前缀。
 */
export function isInsideQuotePrefix(source: string, from: number): boolean {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  return /^[ \t]*(?:>[ \t]*)+$/.test(source.slice(lineStart, from));
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


