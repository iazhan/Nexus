import path from 'node:path';
import { createRequire } from 'node:module';
import type { ProcessorExtractInput, ProcessorResult } from '@nexus/core';

/**
 * PDF 文本提取（Phase 3 / P3-10）。
 *
 * 放主进程而不是复用渲染进程那份 pdfjs（P3-07）：结果要进全文索引，而索引库在主进程 ——
 * 走渲染进程得两次跨进程往返，还会让「索引重建完成」与「文本已入库」变成两个时刻。
 *
 * 用 legacy build（非 legacy 在 Node 里会打 warning，那是官方指定的 Node 入口）、
 * 懒加载、**必须配 `cMapUrl`**（见 `pdfjsAssets()`，不配会静默返回空文本）。
 */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** 缓存 Promise 而不是模块本身：并发的两次提取会共用同一次加载。 */
let pdfjsModule: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModule ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}

/**
 * pdfjs 的静态资源目录（cmaps / standard_fonts）。**非配不可** —— 中文 PDF 的两种
 * 字体编法表现完全不同（实测见 `.workbuddy-ai/tmp/p3-10-cmap-probe.mjs`）：
 *
 * | 字体编法 | 不配 `cMapUrl` | 配上 |
 * | --- | --- | --- |
 * | Type0 + `/Identity-H` + 自带 ToUnicode | `中文` ✓ | `中文` ✓ |
 * | Type0 + `/UniGB-UCS2-H`，无 ToUnicode | **0 项、空文本** ✗ | `中文` ✓ |
 *
 * 第二种的「码位 → Unicode」只能靠外部 cmap 文件，而没有 `cMapUrl` 时 pdfjs 只打一条
 * warning 然后安静地什么都提不出来 —— 落进 UI 上「未提取到文本」。**静默的错答案比
 * 报错贵得多。**
 *
 * 解析不到时退化成「不配」而不是抛错（打包方式变化都可能让路径失效），代价是降级静默，
 * 所以留这条注释：发现「某些中文 PDF 提不出文本」时先查这个路径。
 */
interface PdfjsAssets {
  cMapUrl: string;
  standardFontDataUrl: string;
}

/** `undefined` = 还没算过；`null` = 算过但解析不到。 */
let cachedAssets: PdfjsAssets | null | undefined;

function pdfjsAssets(): PdfjsAssets | null {
  if (cachedAssets === undefined) {
    cachedAssets = null;
    try {
      const require = createRequire(import.meta.url);
      const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
      cachedAssets = {
        // 结尾的分隔符是必须的：pdfjs 直接做 `baseUrl + name` 拼接
        cMapUrl: path.join(packageRoot, 'cmaps') + path.sep,
        standardFontDataUrl: path.join(packageRoot, 'standard_fonts') + path.sep
      };
    } catch {
      // 保持 null
    }
  }
  return cachedAssets;
}

/**
 * 交给 pdfjs 之前，把字节复制成一份**自己拥有 ArrayBuffer 的普通 `Uint8Array`**。
 * 两条实测理由：
 *
 * 1. **pdfjs 会转移走输入的 ArrayBuffer**（`LoopbackPort` + `structuredClone(obj,
 *    { transfer })`），调用方那份视图事后 `byteLength === 0`（实测 586 → 0）却看不
 *    出来，复用同一份字节跑第二次只会得到「坏 PDF」。
 * 2. **pdfjs 在 Node 下拒绝 `Buffer`**（`getDataProp()` 里 `isNodeJS && val instanceof
 *    Buffer` 就 throw），而 `FileService` 读出来正是 `Buffer`。
 *
 * 代价是每个 PDF 多一份**瞬时**内存（等于文件大小）。`extractDocxText` 不做这个复制 ——
 * mammoth 既不转移也不挑构造函数，差别是实测的。
 */
function copyForPdfjs(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * 提取 PDF 的文本。
 *
 * 扫描版 PDF（正文是图像、没有文本层）在这里返回 `empty`，**不是错误**：Phase 3 明确
 * 不做 OCR（蓝图 §18 放在 Phase 5），提不到就是提不到，由界面显示「未提取到文本」。
 */
export async function extractPdfText(input: ProcessorExtractInput): Promise<ProcessorResult> {
  const pdfjs = await loadPdfjs();
  const assets = pdfjsAssets();

  const document = await pdfjs.getDocument({
    data: copyForPdfjs(input.bytes),
    ...(assets ?? {})
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(itemsToText(content.items));
      // 每页用完就释放：几百页的手册不释放会把中间对象都攒在内存里
      page.cleanup();
    }

    // 整体 trim 一次。**不是为了好看** —— 扫描版 PDF 的 textContent 常常不是零项，
    // 而是只剩换行与空格；不 trim 会被判成「提取成功」，界面显示「已提取」却一个字
    // 都搜不到。
    const text = pages.join('\n\n').trim();
    return text.length === 0 ? { status: 'empty', text: '' } : { status: 'extracted', text };
  } finally {
    // 不 destroy 会留下 worker 与字体缓存 —— 索引几百个附件就会积起来
    await document.destroy();
  }
}

/**
 * 把一页的 text items 拼成文本。
 *
 * `content.items` 里混着带 `str` 的文本项和不带 `str` 的**标记项**
 * （`beginMarkedContent` / `endMarkedContent`）。用 `'str' in item` 挡掉，而不是
 * `item.str ?? ''` —— 后者会把「类型不认识」与「这个字是空的」混成同一件事。
 *
 * `hasEOL` 是 pdfjs 在解析阶段算好的换行位置，**不用坐标自己算**（行距、双栏、
 * 旋转文本都会让坐标法出错）。
 */
function itemsToText(items: readonly unknown[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue;
    const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
    if (typeof str === 'string') text += str;
    if (hasEOL === true) text += '\n';
  }
  return text;
}
