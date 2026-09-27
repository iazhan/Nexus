import path from 'node:path';
import { FileServiceError, assetPathFromUrl } from '@nexus/core';

/**
 * `nexus-asset://` 协议（P3-07）：**纯逻辑 + handler 装配**。
 *
 * 这个模块**刻意不 import `electron`**。协议注册（`registerSchemesAsPrivileged`
 * 必须早于 app ready）与 `session.protocol.handle` 的挂载留在 `index.ts` ——
 * 于是「URL → 路径」「Range 头 → 闭区间」「错误 → HTTP 状态」这三件真正容易错的事
 * 可以在普通 Node 下直接单测（`apps/desktop/test/asset-protocol.test.ts`），
 * 不必为它们冷启动一次 Electron。
 *
 * 为什么需要这个协议（而不是像图片那样走 `file://`）：**PDF 要 Range**。
 * 一份 50MB 的 PDF 若只能整份读进内存，打开就会卡死并吃满内存。
 * `file://` 也拿不到 206 与工作区边界，所以图片那条路（§10.4 定案 A）不适用于 PDF。
 *
 * **URL 形状（scheme / host / 参数名 / 编解码）不在这里** —— 它是 main、renderer
 * 与 editor 三方共享的契约，住在 `@nexus/core` 的 `asset/url.ts`。
 * 本模块只负责「拿到路径之后怎么读字节、怎么回响应」。
 */

/**
 * privileged scheme 的权限声明。**必须在 app ready 之前注册。**
 *
 * `bypassCSP: false` 是关键一条：绕过 CSP 会让「每放宽一条都留理由和日期」
 * （§5.1 三条红线第 3 条）直接失效 —— 那样就不需要 CSP 放行了，也就没人会去想
 * 「这条为什么能加载」。宁可多写一条 CSP，也不要一个绕过策略的通道。
 */
export const ASSET_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  bypassCSP: false
} as const;

/** Range 头解析结果。`range` 的 `start` / `end` 是**闭区间**，与 `Content-Range` 逐字对应。 */
export type RangeSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number };

/**
 * 只支持**单区间**的 `bytes=` 形式。
 *
 * 多区间（`bytes=0-1,5-6`）与语法错误一律当作「没带 Range」回 200 全文 ——
 * RFC 允许服务端忽略 Range，而 PDF.js 只发单区间，为多区间实现 multipart/byteranges
 * 是纯粹的无用复杂度。
 */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * 解析 `Range` 头。`size` 是文件总字节数（后缀形式 `bytes=-N` 必须知道它）。
 *
 * 三态而不是「返回 null 表示没带」：**「没带」与「带了但不可满足」是两种不同的响应**
 * （200 全文 vs 416），把它们压成一个 `null` 正是 416 永远发不出去的原因。
 */
export function parseRangeHeader(header: string | null | undefined, size: number): RangeSpec {
  if (header === null || header === undefined) return { kind: 'none' };

  const value = header.trim();
  if (value === '') return { kind: 'none' };

  const match = RANGE_PATTERN.exec(value);
  if (!match) return { kind: 'none' };

  const firstText = match[1] ?? '';
  const lastText = match[2] ?? '';
  const first = firstText === '' ? null : Number(firstText);
  const last = lastText === '' ? null : Number(lastText);

  // `bytes=-`：语法上匹配，但既没有起点也没有长度 → 忽略
  if (first === null && last === null) return { kind: 'none' };

  if (first === null) {
    // 后缀形式 `bytes=-N`：最后 N 字节。N=0 按 RFC 9110 §14.1.2 不可满足。
    if (last === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - (last as number)), end: size - 1 };
  }

  // 起点越界即不可满足 —— 这条同时覆盖了「空文件 + `bytes=0-`」：
  // size=0 时 start=0 >= size=0，RFC 也认为空表示上的 `bytes=0-` 不可满足。
  if (first >= size) return { kind: 'unsatisfiable' };

  // `bytes=0-` 与 `bytes=0-99999999` 都合法，末字节一律夹到 size-1
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  if (end < first) return { kind: 'unsatisfiable' };

  return { kind: 'range', start: first, end };
}

/**
 * 手写 206 响应**必须**自带 `Content-Type` —— 无 Range 那条路原本靠 `net.fetch`
 * 推断，而 206 的 body 是我们自己切的字节，没有任何推断机会。
 */
const ASSET_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
};

export function assetMimeType(filePath: string): string {
  return ASSET_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * handler 需要的最小读取能力。
 *
 * 刻意不写成 `FileService`：`FileService` 结构上就满足它，而收窄成接口之后
 * 测试可以传一个假实现，不必构造真实的 FileService（也不必碰磁盘）。
 */
export interface AssetReader {
  /** 通过边界与类型校验后返回字节长度。 */
  statAsset(filePath: string): Promise<number>;
  /** 读闭区间 `[start, end]`（含两端）。 */
  readAssetRange(filePath: string, start: number, end: number): Promise<Uint8Array>;
}

export type AssetRequestHandler = (request: Request) => Promise<Response>;

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

/**
 * 把字节视图交给 `Response`。
 *
 * TS 5.7 起 `Uint8Array` 带泛型参数（`ArrayBufferLike` 允许 SharedArrayBuffer 支撑），
 * 而 `BodyInit` 只接受 ArrayBuffer 支撑的视图 —— 于是直接传会报类型不兼容。
 * 我们手上的字节来自 `Buffer.alloc` / `subarray`，**一定**由真实 ArrayBuffer 支撑，
 * 所以这里收窄是安全的。
 *
 * **不用 `new Uint8Array(data)` 或 `data.slice()` 来绕过它**：两者都会复制一份，
 * 而这份数据可能是一整个 PDF。
 */
function asBody(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit;
}

/**
 * `FileServiceError.code` → HTTP 状态。
 *
 * 直接复用已有错误码而不是为协议新增一套错误类型：边界判据只有一份
 * （`checkBoundary` / `assertNoSymlinkEscape`），协议层只做翻译。
 *
 * `UNSUPPORTED_TYPE` 也回 **403** 而不是 415：对 renderer 来说「这个路径我不该读」
 * 和「这个路径不存在」是两件事，而「类型不在白名单」属于前者 —— 它同样是一次
 * 被拒绝的越权尝试，不该给出「文件存在但类型不对」这种额外信息。
 */
function statusForError(error: unknown): number {
  if (error instanceof FileServiceError) {
    switch (error.code) {
      case 'OUT_OF_BOUNDS':
      case 'UNSUPPORTED_TYPE':
        return 403;
      case 'NOT_FOUND':
        return 404;
      default:
        return 500;
    }
  }
  return 500;
}

/**
 * 装配协议 handler。
 *
 * 无 Range 时**不走 `net.fetch(pathToFileURL())`**（spike 的写法）：那需要 import
 * `electron`，会让本模块失去「纯 Node 可单测」这条性质。代价是全文要进内存 ——
 * 但这条路径只在客户端**没有**发 Range 时才走到，而 PDF.js 的分页加载始终带 Range。
 * 反过来，Range 那条路（真正的大文件路径）是流式的偏移读，不整份进内存。
 */
export function createAssetHandler(reader: AssetReader): AssetRequestHandler {
  return async (request) => {
    const target = assetPathFromUrl(request.url);
    if (target === null) return textResponse(400, 'missing asset path');

    let size: number;
    try {
      size = await reader.statAsset(target);
    } catch (error) {
      return textResponse(statusForError(error), 'asset unavailable');
    }

    const range = parseRangeHeader(request.headers.get('Range'), size);
    const isHead = request.method === 'HEAD';

    if (range.kind === 'unsatisfiable') {
      return new Response(isHead ? null : 'range not satisfiable', {
        status: 416,
        headers: {
          // 416 的 Content-Range 用 `bytes */size` 形式，分母仍然要有
          'content-range': `bytes */${size}`,
          'accept-ranges': 'bytes',
          'content-type': 'text/plain; charset=utf-8'
        }
      });
    }

    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : size - 1;

    let data: Uint8Array;
    try {
      // size === 0 时 end = -1，区间非法 —— 空文件直接给空 body。
      data = size === 0 ? new Uint8Array(0) : await reader.readAssetRange(target, start, end);
    } catch (error) {
      return textResponse(statusForError(error), 'asset unavailable');
    }

    // 文件在 stat 与 read 之间被截断时实际长度会小于请求长度。用**实际**长度算末字节，
    // 否则 content-range 与 content-length 会互相矛盾（这种响应比 416 更难查）。
    const actualEnd = data.byteLength === 0 ? start : start + data.byteLength - 1;
    const headers: Record<string, string> = {
      'content-length': String(data.byteLength),
      'accept-ranges': 'bytes',
      'content-type': assetMimeType(target)
    };
    if (range.kind === 'range') {
      headers['content-range'] = `bytes ${start}-${actualEnd}/${size}`;
    }

    const status = range.kind === 'range' ? 206 : 200;
    return new Response(isHead ? null : asBody(data), { status, headers });
  };
}
