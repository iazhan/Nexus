import { describe, expect, it } from 'vitest';
import {
  ASSET_HOST,
  ASSET_PATH_PARAM,
  ASSET_SCHEME,
  FileServiceError
} from '@nexus/core';
import {
  assetMimeType,
  createAssetHandler,
  parseRangeHeader,
  type AssetReader
} from '../electron/asset-protocol.js';

/**
 * `nexus-asset://` 协议 handler 的行为测试（P3-07）。
 *
 * 这个文件**不启动 Electron**：协议模块刻意不 import `electron`，所以
 * 「Range 头 → 闭区间」「错误 → 状态码」都能在这里逐条钉死。
 * 真正需要真机的部分（CSP 放行、Chromium 真的发出 206、PDF.js 真的渲染出像素）
 * 归 `p3-07-pdf-viewer.test.ts`。
 *
 * **URL 形状（编解码、常量）不在这里测** —— 它住在 `@nexus/core` 的 `asset/url.ts`，
 * 由 `packages/core/test/asset-url.test.ts` 覆盖。这个文件只测「拿到路径之后
 * 怎么读字节、怎么回响应」。两边都不重复断言，是因为重复的断言会在改契约时
 * 一处红一处绿，让人分不清哪个才是权威。
 */

/**
 * 构造 URL，**刻意不做反斜杠归一化**。
 *
 * 这个 helper 服务于「测 main 侧解码器」的用例：入参是反斜杠路径，期望
 * `assetPathFromUrl` **原样**返回它（归一化是 `FileService` 的职责，不是协议层的）。
 * 所以不能换成渲染器的 `toAssetUrl` —— 那个会把 `\` 换成 `/`，把这些用例
 * 变成在测归一化，而不是在测解码。
 *
 * 「渲染器产出的 URL 能被 main 侧正确解析」由下面的 `与渲染器 asset-url.ts 的契约`
 * 一组覆盖，那里用的才是真正的 `toAssetUrl`。
 */
function rawAssetUrl(targetPath: string): string {
  return `${ASSET_SCHEME}://${ASSET_HOST}/?${ASSET_PATH_PARAM}=${encodeURIComponent(targetPath)}`;
}

function createFakeReader(content: Uint8Array, overrides: Partial<AssetReader> = {}): AssetReader {
  return {
    statAsset: async () => content.byteLength,
    readAssetRange: async (_filePath, start, end) => content.slice(start, end + 1),
    ...overrides
  };
}

/** 0..255 循环的确定性字节，便于按值断言「真的按偏移读了」。 */
function countingBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
  return bytes;
}

describe('parseRangeHeader', () => {
  it('没有 Range 头 → none（回 200 全文）', () => {
    expect(parseRangeHeader(null, 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader(undefined, 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('', 1000)).toEqual({ kind: 'none' });
  });

  it('bytes=0-99 → 闭区间 0-99（末字节就是 99，不是 100）', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('bytes=a- 省略末字节 → 读到文件末尾', () => {
    expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ kind: 'range', start: 100, end: 999 });
  });

  it('bytes=-N 是**后缀**形式：最后 N 字节，起点是 size - N', () => {
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
  });

  it('后缀长度超过文件 → 从头开始（start 夹到 0）', () => {
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('bytes=-0 不可满足（RFC 9110 §14.1.2 的后缀长度为 0）', () => {
    expect(parseRangeHeader('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('起点等于文件大小 → 不可满足（回 416，不是空 200）', () => {
    expect(parseRangeHeader('bytes=1000-1099', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('空文件上的 bytes=0- 不可满足', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('末字节超出文件 → 夹到 size-1（bytes=0-99999999 是合法请求）', () => {
    expect(parseRangeHeader('bytes=0-99999999', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('首末相等是合法的单字节区间', () => {
    expect(parseRangeHeader('bytes=7-7', 1000)).toEqual({ kind: 'range', start: 7, end: 7 });
    expect(parseRangeHeader('bytes=0-0', 1)).toEqual({ kind: 'range', start: 0, end: 0 });
  });

  it('末字节小于首字节 → 不可满足', () => {
    expect(parseRangeHeader('bytes=50-10', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('多区间（bytes=0-1,5-6）当作没带 Range：RFC 允许服务端忽略，PDF.js 也只发单区间', () => {
    expect(parseRangeHeader('bytes=0-1,5-6', 1000)).toEqual({ kind: 'none' });
  });

  it('单位不是 bytes / 语法错误 → none，而不是 416', () => {
    expect(parseRangeHeader('items=0-9', 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=abc-def', 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('0-9', 1000)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=-', 1000)).toEqual({ kind: 'none' });
  });

  it('两侧空白不影响解析（代理可能加上空白）', () => {
    expect(parseRangeHeader('  bytes=0-9  ', 1000)).toEqual({ kind: 'range', start: 0, end: 9 });
  });
});

describe('assetMimeType', () => {
  it('按扩展名给出 Content-Type，大小写不敏感', () => {
    expect(assetMimeType('D:\\a\\b.pdf')).toBe('application/pdf');
    expect(assetMimeType('D:\\a\\B.PDF')).toBe('application/pdf');
  });

  it('未知扩展名回退 octet-stream，而不是猜一个错的', () => {
    expect(assetMimeType('D:\\a\\b.xyz')).toBe('application/octet-stream');
    expect(assetMimeType('D:\\a\\noext')).toBe('application/octet-stream');
  });
});

describe('createAssetHandler', () => {
  const CONTENT = countingBytes(1000);
  const TARGET = 'D:\\notes\\sample.pdf';

  it('无 Range → 200 全文，并声明 accept-ranges', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(new Request(rawAssetUrl(TARGET)));

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-length')).toBe('1000');
    expect(response.headers.get('content-range')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT);
  });

  it('起点等于文件大小 → 416，Content-Range 用 bytes */size 形式（分母仍然要有）', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(
      new Request(rawAssetUrl(TARGET), { headers: { Range: 'bytes=1000-1099' } })
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */1000');
  });

  it('Range 命中 → 206，body 长度与偏移都正确', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(
      new Request(rawAssetUrl(TARGET), { headers: { Range: 'bytes=100-199' } })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toHaveLength(100);
    expect(body[0]).toBe(100 % 256); // 1000 % 256 = 232，若读成文件开头会是 0
  });

  it('后缀 Range（bytes=-100）→ 206，取的是文件末尾那 100 字节', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(
      new Request(rawAssetUrl(TARGET), { headers: { Range: 'bytes=-100' } })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 900-999/1000');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body[0]).toBe(900 % 256);
  });

  it('空文件 + 无 Range → 200 空 body，不抛区间越界', async () => {
    const handler = createAssetHandler(createFakeReader(new Uint8Array(0)));
    const response = await handler(new Request(rawAssetUrl(TARGET)));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('0');
  });

  it('HEAD → 状态与头正确、body 为空（不能把整份 PDF 塞给 HEAD）', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(new Request(rawAssetUrl(TARGET), { method: 'HEAD' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('1000');
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
  });

  it('缺 path 参数 → 400', async () => {
    const handler = createAssetHandler(createFakeReader(CONTENT));
    const response = await handler(new Request(`${ASSET_SCHEME}://${ASSET_HOST}/`));

    expect(response.status).toBe(400);
  });

  it('边界越权（OUT_OF_BOUNDS）→ 403，且不泄漏路径', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        statAsset: async () => {
          throw new FileServiceError('OUT_OF_BOUNDS', '访问路径超出允许边界: D:\\secret.txt');
        }
      })
    );
    const response = await handler(new Request(rawAssetUrl('D:\\secret.txt')));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('secret');
  });

  it('类型不在白名单（UNSUPPORTED_TYPE）→ 同样 403（它也是一次越权尝试）', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        statAsset: async () => {
          throw new FileServiceError('UNSUPPORTED_TYPE', '不支持的文件类型');
        }
      })
    );
    expect((await handler(new Request(rawAssetUrl(TARGET)))).status).toBe(403);
  });

  it('文件不存在 → 404', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        statAsset: async () => {
          throw new FileServiceError('NOT_FOUND', '文件未找到');
        }
      })
    );
    expect((await handler(new Request(rawAssetUrl(TARGET)))).status).toBe(404);
  });

  it('读取阶段才失败也要映射成正确的状态（不能一律 500）', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        readAssetRange: async () => {
          throw new FileServiceError('NOT_FOUND', '文件未找到');
        }
      })
    );
    const response = await handler(
      new Request(rawAssetUrl(TARGET), { headers: { Range: 'bytes=0-9' } })
    );
    expect(response.status).toBe(404);
  });

  it('非 FileServiceError → 500，不把内部异常细节吐给 renderer', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        statAsset: async () => {
          throw new Error('EACCES: D:\\very\\secret\\path');
        }
      })
    );
    const response = await handler(new Request(rawAssetUrl(TARGET)));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });

  it('文件在 stat 与 read 之间被截断 → Content-Range 用**实际**长度，不与 Content-Length 矛盾', async () => {
    const handler = createAssetHandler(
      createFakeReader(CONTENT, {
        readAssetRange: async () => countingBytes(40) // 请求 100 字节只拿到 40
      })
    );
    const response = await handler(
      new Request(rawAssetUrl(TARGET), { headers: { Range: 'bytes=100-199' } })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 100-139/1000');
    expect(response.headers.get('content-length')).toBe('40');
  });
});
