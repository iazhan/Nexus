import { documentTypeForPath } from './extensions.js';
import { normalizeWikilinkTarget } from './links.js';

/**
 * 从 Markdown 源码里扫出**它引用了哪些附件**（Phase 3 / P3-10）。
 *
 * 计划 §10.1 决策 1 定的是「只索引被 Markdown 引用过的附件」，所以 P3-10 的输入不是
 * 「工作区全部附件」而是「被引用附件集合」。那条决策还写着「要在 P3-04 的 schema 里
 * 一并考虑，否则 P3-10 会返工」—— P3-04 没做，补在这里。
 *
 * 与 `extractWikiLinkTargets()` 的区别：那个只管 wikilink（喂 `links` 表），这里管
 * **所有能指向一个文件的写法**（图片、链接、wikilink、HTML `<img>`）。两者共用
 * `normalizeWikilinkTarget()`，所以「`[[stm32]]` 指到谁」只有一份口径。
 *
 * 取舍同样是**偏召回**：代码块里的引用也收。多收一条只是多提取一次（几十毫秒），
 * 漏一条却会表现成「这个 PDF 明明引用了却搜不到」。
 */
export interface AttachmentReferences {
  /**
   * 解析出的**工作区相对路径**，正斜杠、保留原始大小写，已去重。
   *
   * 是「引用指向的路径」而非「磁盘上真存在的文件」—— 引用一个还没建的文件是合法的，
   * 调用方拿去和索引比对，比不中的自然落空。
   */
  paths: readonly string[];
  /**
   * wikilink 目标，**已归一化**（去 `.md`、转小写），已去重。
   *
   * 与 `links` 表同一口径，否则会出现「能跳转但没被索引」。名字式引用没有目录信息，
   * 所以调用方要拿候选集去比对（`wikilinkCandidates()`）。
   */
  wikilinkTargets: readonly string[];
}

/**
 * `![alt](src)` / `[text](src)` 与 HTML `<img src="...">`，**合成一条**正则 —— 分两遍
 * 扫出来的顺序是「先全部图片、再全部 HTML」，与源码无关却会被测试断言。
 *
 * 分组：`1,2` = Markdown 目标（尖括号 / 裸写），`3,4,5` = HTML img 的 src（双引号 /
 * 单引号 / 不加引号）。改动时两处要一起改。
 *
 * 取舍：不处理嵌套方括号（为它写括号配平器会把「扫引用」变成半个 parser）；支持
 * `<...>` 与 `"title"`；不支持引用式链接 `[text][ref]`（要两趟解析，漏掉只是「不进
 * 索引」，将来补是纯新增）。`i` 标志只对 HTML 那半边有用。
 */
const REFERENCE_PATTERN =
  /!?\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^)\s]*))|<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** `[[目标]]` 或 `[[目标|别名]]`。与 `indexer.ts` 的 `WIKILINK_PATTERN` 同形。 */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/**
 * 扫出 `source` 里对附件的引用。
 *
 * `sourceRelativePath` 是这篇 Markdown 自己的**工作区相对路径** —— 相对引用以它所在
 * 目录为基准解析：传 `'notes/dma.md'` 时 `![](../img/a.png)` 解析成 `img/a.png`。
 */
export function attachmentReferences(
  source: string,
  sourceRelativePath: string
): AttachmentReferences {
  const paths = new Set<string>();
  const wikilinkTargets = new Set<string>();

  for (const match of source.matchAll(REFERENCE_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    const resolved = resolveWorkspacePath(sourceRelativePath, raw);
    if (resolved !== null && isAttachmentPath(resolved)) paths.add(resolved);
  }

  for (const match of source.matchAll(WIKILINK_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const normalized = normalizeWikilinkTarget(raw);
    if (normalized.length === 0) continue;
    wikilinkTargets.add(normalized);
  }

  return { paths: [...paths], wikilinkTargets: [...wikilinkTargets] };
}

/**
 * 把引用里写的目标解析成工作区相对路径；**解析不出来就返回 `null`**（空串 / 只有锚点、
 * 带 scheme、协议相对、`..` 逃出工作区根、归一化后什么都不剩）。
 *
 * 顺序上刻意**先解码、再切段**：`%2e%2e%2f`（即 `../`）必须在切成路径段之前还原，
 * 否则逃逸检查看不见它 —— 那正是「边界校验被绕过」的经典形态。
 */
export function resolveWorkspacePath(
  sourceRelativePath: string,
  raw: string
): string | null {
  let target = raw.trim();

  // `<...>` 包裹：尖括号里可以有空格（`<my file.png>`）
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }

  // 锚点与查询串。蓝图 §11.4 的页码引用就是 `attachments/stm32.pdf#page=342`，
  // 必须把 `#page=342` 切掉，否则整个字符串都会被当成文件名。
  const hashIndex = target.indexOf('#');
  if (hashIndex >= 0) target = target.slice(0, hashIndex);
  const queryIndex = target.indexOf('?');
  if (queryIndex >= 0) target = target.slice(0, queryIndex);

  target = target.trim();
  if (target.length === 0) return null;

  // 放在最前面：`data:image/png;base64,...` 既没有 `/` 也没有扩展名，
  // 落到后面会被当成一个奇怪的文件名。
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith('//')) return null;

  try {
    target = decodeURIComponent(target);
  } catch {
    // 非法的百分号序列（`100%.png`）—— 保留原样，它就是个普通文件名
  }

  target = target.replace(/\\/g, '/');

  // 前导 `/` = 工作区根（Obsidian 的 vault 根写法），不是文件系统根
  const rooted = target.startsWith('/');
  const segments: string[] = rooted ? [] : splitSegments(sourceRelativePath).slice(0, -1);

  for (const segment of target.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      // 逃出工作区根 —— 一律丢弃，不「尽力而为」地钳到根上
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length === 0 ? null : segments.join('/');
}

function splitSegments(relativePath: string): string[] {
  return relativePath.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0);
}

/** 是不是一个「附件」—— 在白名单里，且不是 Markdown。 */
function isAttachmentPath(filePath: string): boolean {
  const documentType = documentTypeForPath(filePath);
  return documentType !== null && documentType !== 'markdown';
}
