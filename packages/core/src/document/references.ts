import { CODE_FILLER, maskCodeRegions } from './code-regions.js';
import { documentTypeForPath } from './extensions.js';
import { normalizeWikilinkTarget } from './links.js';
import { relativePathFrom } from './citation.js';

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
   * wikilink 目标，**已归一化**（切掉 `#锚点`、去 `.md`、转小写），已去重。
   *
   * 与 `links` 表同一口径，否则会出现「能跳转但没被索引」。名字式引用没有目录信息，
   * 所以调用方要拿候选集去比对（`wikilinkCandidates()`）。
   *
   * 切锚点这一半是必须的：`[[stm32.pdf#page=342]]` 引用的就是那个 PDF，
   * 锚点只是「翻到第几页」。不切的话这份引用集里没有它，附件会被判成「没被引用」，
   * 于是提取过的正文被清掉 —— 症状是「明明引用了却搜不到」。
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
 *
 * `d` 标志（`hasIndices`）是给回写用的：`rewriteAttachmentReferences()` 必须知道
 * **每个分组在源码里的位置**才能只换目标那一小段。加上它不影响 `attachmentReferences()`
 * —— 那边只用分组的值。
 */
const REFERENCE_PATTERN =
  /!?\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^)\s]*))|<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gid;

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

/** 反斜杠转正斜杠。`resolveWorkspacePath()` 的产物已经是这样，跨进程传进来的不一定。 */
function normalizeSlashes(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/** 是不是一个「附件」—— 在白名单里，且不是 Markdown。 */
function isAttachmentPath(filePath: string): boolean {
  const documentType = documentTypeForPath(filePath);
  return documentType !== null && documentType !== 'markdown';
}

/** 一次回写的结果。`text` 没改动时与入参**同一个字符串**（调用方可以拿 `===` 快速判断）。 */
export interface ReferenceRewrite {
  readonly text: string;
  /** 真正改了几处 */
  readonly count: number;
  /**
   * 认出来指向被改名对象、却**写不出来**的引用原文。
   *
   * 交给调用方如实报出（「N 处引用无法自动更新」），不要静默吞掉 ——
   * 用户看不到清单的话，只会以为链接自己断了。
   */
  readonly skipped: readonly string[];
}

/**
 * 把一篇 Markdown 里**所有指向 `from` 的附件引用**改成指向 `to`；其余一个字节都不动。
 *
 * 与 `rewriteWikiLinkTarget()` 分工一致：判定用 `resolveWorkspacePath()`（与索引期
 * 「这篇引用了哪些附件」同一个函数），变换只负责把写法原样保留下来。
 *
 * **判定大小写不敏感**：Windows 上 `Assets/Logo.png` 与 `assets/logo.png` 是同一个
 * 文件，而 `resolveWorkspacePath()` 保留写法的原始大小写。比较由这里统一做，
 * 新写法一律用 `to` 的真实大小写。
 *
 * 顺带说明「为什么不用 `attachmentReferences()` 找候选」：那个函数只返回**去重后的
 * 路径集合**，没有位置信息；回写必须知道每一处在源码里的 `[start, end)` 才能只换目标
 * 那一小段。两者共用同一条 `REFERENCE_PATTERN`，所以「扫得出」与「改得到」不会脱节。
 */
export function rewriteAttachmentReferences(
  source: string,
  sourceRelativePath: string,
  from: string,
  to: string
): ReferenceRewrite {
  return rewriteAttachmentReferencesForMany(source, sourceRelativePath, [{ from, to }]);
}

/** 一次「从哪搬到哪」。两端都是**工作区相对路径**。 */
export interface ReferenceRewritePair {
  from: string;
  to: string;
}

/**
 * 一次改**多组** `from → to`。
 *
 * 为什么需要它：搬一个**目录**时，指向它里面每一个附件的引用都要跟着改 —— 逐个调用
 * 单组版本是 O(目录内文件数 × 全部文档数) 次全文正则扫描。这里把那一组 pair 收成一个
 * `Map`，**全文只扫一遍**。单组版本是它的单元素调用。
 *
 * **代码区不参与。** 与 `rewriteWikiLinkTarget()` 那一侧同源：文档里到处是
 * ``` ![](assets/x.png) ``` 这样的例子，改它们就是把用户写的文档改成错的。
 * 掩码是等长的（见 `maskCodeRegions()`），所以分组下标仍然直接对应原文。
 */
export function rewriteAttachmentReferencesForMany(
  source: string,
  sourceRelativePath: string,
  pairs: readonly ReferenceRewritePair[]
): ReferenceRewrite {
  if (pairs.length === 0) return { text: source, count: 0, skipped: [] };

  const byFrom = new Map<string, ReferenceRewritePair>();
  for (const pair of pairs) byFrom.set(pair.from.toLowerCase(), pair);

  const edits: { start: number; end: number; replacement: string }[] = [];
  const skipped: string[] = [];

  for (const match of maskCodeRegions(source).matchAll(REFERENCE_PATTERN)) {
    const indices = match.indices;
    if (indices === undefined) continue;
    // 跨掩码区的假匹配：填充字符不匹配 `]` 或 `)`，但会匹配 `[^)\s]*` 这类否定字符类。
    // 判据见 `code-regions.ts` 的头注释。
    if (match[0].includes(CODE_FILLER)) continue;

    for (const group of [1, 2, 3, 4, 5] as const) {
      const written = match[group];
      const span = indices[group];
      if (written === undefined || span === undefined) continue;

      const resolved = resolveWorkspacePath(sourceRelativePath, written);
      if (resolved === null) continue;
      const pair = byFrom.get(resolved.toLowerCase());
      if (!pair) continue;

      // 分组 1 是 `<...>` **里面**那一段。`rewriteAttachmentTarget()` 的入参/返回值都是
      // 「整个目标怎么写」（含尖括号），所以这里把尖括号拼回去、替换范围也一起圈进来 ——
      // 否则会写出 `<<a.png>>` 这种语法坏掉的正文。
      const wrapped = group === 1;
      const rawTarget = wrapped ? `<${written}>` : written;

      const replacement = rewriteAttachmentTarget(
        rawTarget,
        sourceRelativePath,
        pair.from,
        pair.to
      );
      if (replacement === null) {
        skipped.push(rawTarget);
        continue;
      }
      if (replacement === rawTarget) continue;

      edits.push({
        start: wrapped ? span[0] - 1 : span[0],
        end: wrapped ? span[1] + 1 : span[1],
        replacement
      });
    }
  }

  if (edits.length === 0) return { text: source, count: 0, skipped };

  // 从后往前替换：前面的编辑不会让后面记录的偏移失效。
  edits.sort((a, b) => a.start - b.start);
  let text = source;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }

  return { text, count: edits.length, skipped };
}

/**
 * 把**一处**附件引用改成指向 `to`；认不出来或写不出来返回 `null`。
 *
 * 保留的东西（一条都不能丢，丢了就是静默改语义）：
 *
 * | 用户写的 | 保留 |
 * | --- | --- |
 * | `../assets/logo.png` | 相对基准是**文档所在目录**，改完按新路径重算 |
 * | `/assets/logo.png` | 前导 `/` = 工作区根（Obsidian 的 vault 根写法），不改写成相对 |
 * | `<assets/my logo.png>` | 尖括号包裹 |
 * | `assets/my%20logo.png` | 原来是百分号编码的，新路径继续编码 |
 * | `attachments/stm32.pdf#page=342` | 锚点与查询串（切第一个 `#` 或 `?` 之后的全部） |
 *
 * 新名字里含空格时**补上**尖括号 —— 原来没包裹是因为原来没空格，不是用户表达过
 * 「不要包裹」。
 */
export function rewriteAttachmentTarget(
  raw: string,
  sourceRelativePath: string,
  from: string,
  to: string
): string | null {
  const resolved = resolveWorkspacePath(sourceRelativePath, raw);
  if (resolved === null || resolved.toLowerCase() !== from.toLowerCase()) return null;

  let body = raw.trim();
  const wrapped = body.startsWith('<') && body.endsWith('>');
  if (wrapped) body = body.slice(1, -1).trim();

  // `resolveWorkspacePath` 先切 `#` 再切 `?`，所以后缀要从**最先出现的那个**开始，
  // 否则 `a.png?v=2#x` 会被切成两段、中间那段凭空消失。
  const suffixIndex = firstIndexOfAny(body, '#?');
  const suffix = suffixIndex >= 0 ? body.slice(suffixIndex) : '';
  const writtenPath = (suffixIndex >= 0 ? body.slice(0, suffixIndex) : body).trim();
  if (writtenPath.length === 0) return null;

  const decoded = decodePath(writtenPath);
  const encoded = decoded !== writtenPath;

  let nextPath: string;
  if (decoded.startsWith('/')) {
    nextPath = `/${to}`;
  } else {
    const relative = relativeFromDirectory(directoryOf(sourceRelativePath), to);
    if (relative === null) return null;
    nextPath = relative;
    // 用户写了 `./a.png` 就别给他换成 `a.png` —— 改的是指向，不是排版。
    // 新路径本来就以 `../` 开头时不能再加（`./../x` 只会更难读）。
    if (decoded.startsWith('./') && !nextPath.startsWith('../')) nextPath = `./${nextPath}`;
  }

  const out = encoded ? encodePath(nextPath) : nextPath;
  // `<` `>` 在 Windows 上是合法文件名字符，但写进 `<...>` 或裸写都会破坏语法 ——
  // 宁可让链接断掉（可见的 not-found），也不要写出一段解析不回来的正文。
  if (/[<>\r\n]/.test(out)) return null;

  return (wrapped || /\s/.test(out) ? `<${out}>` : out) + suffix;
}

/**
 * 把一个文档的**出链**重基准：文档自己换了目录，里面那些相对写法要跟着换基准。
 *
 * ## 与 `rewriteAttachmentReferences()` 的分工
 *
 * 那个函数改的是「**指向**某个被改名/移动对象的引用」，住在**别人**的文档里。
 * 这个函数改的是「文档**自己的**出链」—— 它自己挪了窝，`![](../assets/x.png)` 里的
 * `../` 就少了一层。两者是搬一个文件时要做的两件不同的事。
 *
 * ## 只有 Markdown 相对写法受影响
 *
 * wikilink（`[[a/b]]`）的路径段是**工作区根相对**，换目录不影响它 —— 这里刻意不碰，
 * 与 `rewriteWikiLinkTarget()` 的分工一致（那边管 wikilink 的名字部分）。
 *
 * ## 为什么需要 `moves`
 *
 * 搬一个**目录**时，目录内部的文件是**一起**走的 —— `notes/a.md` 里的 `[b](b.md)`
 * 指的那个 `notes/b.md` 也变成了 `archive/b.md`。只看这一个文档的新旧路径，会把它算成
 * `../notes/b.md` —— 而 `notes/b.md` 已经不存在了，**我们亲手把它改断**。
 *
 * 所以调用方要把「这一次一起搬走的全部文件」传进来（含它自己）。省略时按「只有它自己搬」
 * 处理，也就是单文件移动。
 *
 * ## 什么算「认出来」
 *
 * 判定用 `resolveWorkspacePath()`（与索引期「这篇引用了哪些附件」同一个函数），
 * 所以「扫得出的」与「改得到的」是同一批。**但它返回 `null` 不等于失败** ——
 * 外链、纯锚点、根相对（前导 `/` = 工作区根）、指向文档自己的引用，全都属于
 * 「本来就不该动」，静默跳过。只有「该改却写不出来」（新路径含 `<` `>` 之类）才进 `skipped`。
 *
 * ## 代码区
 *
 * 在 `maskCodeRegions()` 的产物上扫，与 `rewriteWikiLinks()` 同源。另外**整段含填充字符的
 * 匹配一律丢掉**：填充字符不匹配 `]` 或 `)`，但会匹配 `[^\]\s]*` 这类否定字符类，
 * 于是「引用被代码区从中间劈开」的假匹配是可能的。见 `code-regions.ts` 的头注释。
 *
 * @param fromRelativePath 文档**原来**的工作区相对路径
 * @param toRelativePath   文档**现在**的工作区相对路径
 * @param moves            与它一起搬走的**全部**文件（含它自己）。省略 = 只有它自己搬
 */
export function rebaseRelativeReferences(
  source: string,
  fromRelativePath: string,
  toRelativePath: string,
  moves: readonly ReferenceRewritePair[] = [{ from: fromRelativePath, to: toRelativePath }]
): ReferenceRewrite {
  const fromDirectory = directoryOf(fromRelativePath);
  const toDirectory = directoryOf(toRelativePath);

  // 同一个目录 = 相对基准没变。提前返回，调用方拿 `===` 就能判「什么都没发生」。
  // 大小写按比较处理：Windows 上 `Notes/` 与 `notes/` 是同一层，深度也一样，
  // 但没必要为它走一遍全正则。
  if (fromDirectory.toLowerCase() === toDirectory.toLowerCase()) {
    return { text: source, count: 0, skipped: [] };
  }

  const edits: { start: number; end: number; replacement: string }[] = [];
  const skipped: string[] = [];
  // `resolveWorkspacePath()` 的产物一律是正斜杠拼接的，所以比较键也要先归一化 ——
  // 否则 `notes\daily.md` 这种输入永远比不上自己。
  const fromKey = splitSegments(fromRelativePath).join('/').toLowerCase();

  // 键是**旧**路径。引用解析出来之后先在这里查一遍：查得到就说明它指的那个也搬了，
  // 得跟着换地方（见上面「为什么需要 `moves`」）。
  const movedTo = new Map<string, string>();
  for (const move of moves) {
    movedTo.set(splitSegments(move.from).join('/').toLowerCase(), normalizeSlashes(move.to));
  }

  for (const match of maskCodeRegions(source).matchAll(REFERENCE_PATTERN)) {
    const indices = match.indices;
    if (indices === undefined) continue;
    // 跨掩码区的假匹配。判据见 `code-regions.ts`。
    if (match[0].includes(CODE_FILLER)) continue;

    for (const group of [1, 2, 3, 4, 5] as const) {
      const written = match[group];
      const span = indices[group];
      if (written === undefined || span === undefined) continue;

      // 分组 1 是 `<...>` **里面**那一段。替换范围要连尖括号一起圈进来，
      // 否则会写出 `<<a.png>>` 这种语法坏掉的正文（与 `rewriteAttachmentReferences` 同一条）。
      const wrapped = group === 1;
      const rawTarget = wrapped ? `<${written}>` : written;

      const resolved = resolveWorkspacePath(fromRelativePath, rawTarget);
      if (resolved === null) continue;
      // 指向文档自己（`[Self](daily.md#section)`）—— 它跟着文档走，重基准反而会让它指到别处。
      if (resolved.toLowerCase() === fromKey) continue;

      const parsed = parseRawReference(rawTarget);
      // 前导 `/` = 工作区根（Obsidian 的 vault 根写法），与文档在哪一层无关。
      if (parsed === null || parsed.decodedPath.startsWith('/')) continue;

      // 它指的那个也搬了 → 目标换成新家，否则重基准出来的路径指向一个已经不存在的旧位置。
      const target = movedTo.get(resolved.toLowerCase()) ?? resolved;

      const replacement = rebaseParsedReference(parsed, toDirectory, target);
      if (replacement === null) {
        skipped.push(rawTarget);
        continue;
      }
      if (replacement === rawTarget) continue;

      edits.push({
        start: wrapped ? span[0] - 1 : span[0],
        end: wrapped ? span[1] + 1 : span[1],
        replacement
      });
    }
  }

  if (edits.length === 0) return { text: source, count: 0, skipped };

  // 从后往前替换：前面的编辑不会让后面记录的偏移失效。
  edits.sort((a, b) => a.start - b.start);
  let text = source;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }

  return { text, count: edits.length, skipped };
}

/** 一处引用拆开后的样子。解析只做一次，判定与变换共用。 */
interface RawReference {
  /** 去掉尖括号、去空白之后的路径部分（**未解码**）。 */
  readonly writtenPath: string;
  /** 解码之后的路径部分 —— 用来判「是不是根相对」。 */
  readonly decodedPath: string;
  /** 原来是百分号编码的。新路径要继续编码，否则改的是排版不是指向。 */
  readonly encoded: boolean;
  /** `#锚点` / `?查询` 那一段，含前导符号。 */
  readonly suffix: string;
  /** 原来有 `<...>` 包裹。 */
  readonly wrapped: boolean;
  /** 原来是 `./` 开头。 */
  readonly dotPrefixed: boolean;
}

/**
 * 拆一处引用。拆不出来（空路径）返回 `null`。
 *
 * 后缀从**最先出现的** `#` 或 `?` 开始 —— 与 `resolveWorkspacePath()` 先切 `#` 再切 `?`
 * 的顺序对齐，否则 `a.png?v=2#x` 会被切成两段、中间那段凭空消失。
 */
function parseRawReference(raw: string): RawReference | null {
  let body = raw.trim();
  const wrapped = body.startsWith('<') && body.endsWith('>');
  if (wrapped) body = body.slice(1, -1).trim();

  const suffixIndex = firstIndexOfAny(body, '#?');
  const suffix = suffixIndex >= 0 ? body.slice(suffixIndex) : '';
  const writtenPath = (suffixIndex >= 0 ? body.slice(0, suffixIndex) : body).trim();
  if (writtenPath.length === 0) return null;

  const decodedPath = decodePath(writtenPath);
  return {
    writtenPath,
    decodedPath,
    encoded: decodedPath !== writtenPath,
    suffix,
    wrapped,
    dotPrefixed: decodedPath.startsWith('./')
  };
}

/**
 * 算出一处引用在新目录下的写法；写不出来返回 `null`。
 *
 * `target` 是**已经解析好的工作区相对路径**（`resolveWorkspacePath()` 的产物）——
 * 变换只负责把它重新表达成「相对 `toDirectory` 的样子」，不再判一遍指向谁。
 */
function rebaseParsedReference(
  reference: RawReference,
  toDirectory: string,
  target: string
): string | null {
  const relative = relativeFromDirectory(toDirectory, target);
  if (relative === null) return null;

  let nextPath = relative;
  // 用户写了 `./a.png` 就别给他换成 `a.png` —— 改的是指向，不是排版。
  // 新路径本来就以 `../` 开头时不能再加（`./../x` 只会更难读）。
  if (reference.dotPrefixed && !nextPath.startsWith('../')) nextPath = `./${nextPath}`;

  const out = reference.encoded ? encodePath(nextPath) : nextPath;
  // `<` `>` 在 Windows 上是合法文件名字符，但写进 `<...>` 或裸写都会破坏语法 ——
  // 宁可让链接断掉（可见的 not-found），也不要写出一段解析不回来的正文。
  if (/[<>\r\n]/.test(out)) return null;

  return (reference.wrapped || /\s/.test(out) ? `<${out}>` : out) + reference.suffix;
}

/** 第一个 `#` 或 `?` 的下标；都没有返回 -1。 */
function firstIndexOfAny(text: string, chars: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (chars.includes(text[index]!)) return index;
  }
  return -1;
}

/** 百分号解码；非法序列（`100%.png`）原样返回 —— 与 `resolveWorkspacePath` 同一口径。 */
function decodePath(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 重新编码。`encodeURI` 不碰 `/` 与 `.`，正好是路径里该留的那两个。 */
function encodePath(text: string): string {
  return encodeURI(text);
}

/** `notes/dma.md` → `notes`；根目录下的文档返回空串。 */
function directoryOf(relativePath: string): string {
  const segments = splitSegments(relativePath);
  return segments.slice(0, -1).join('/');
}

/**
 * 从 `directory`（工作区相对）到 `target`（工作区相对）的相对路径。
 *
 * 复用 `relativePathFrom()`（它要**绝对路径**）而不是另写一份：给两边拼同一个假根
 * 即可。它与 `resolveWorkspacePath()` 是同一套 `..` 语义的两半 —— 各写一份必然漂。
 *
 * `target` 就是 `directory` 自己时返回 `null`（没有可写的相对路径）。
 */
export function relativeFromDirectory(directory: string, target: string): string | null {
  const fakeRoot = 'X:/';
  return relativePathFrom(fakeRoot + directory, fakeRoot + target);
}
