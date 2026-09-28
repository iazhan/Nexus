// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';
import { createPdf } from './fixtures/documents.js';
import { toAssetUrl } from '@nexus/core';

/**
 * P3-07 的端到端验收：**PDF 真的被渲染出像素了**，而且 Range 通道在真实
 * Electron 里按预期工作。
 *
 * 纯逻辑层（URL 形状、Range 解析、错误映射）已经在 `asset-protocol.test.ts`
 * 逐条钉死，那个文件**不启动 Electron**。这个文件只验「只有真机才能验的四件事」：
 *
 * 1. **CSP 放行** —— `connect-src nexus-asset:` 与 `worker-src` 生效，
 *    pdfjs 能 fetch 到字节、能起 worker。CSP 写错了在纯逻辑层完全看不出来。
 * 2. **Chromium 真的收到 206** —— 不是我们「构造了 206」，而是浏览器拿到它
 *    并把它当分页数据用。
 * 3. **canvas 上真的出现了非白像素** —— pdfjs 解析成功、绘制成功。
 *    这条同时覆盖了 worker 启动、cmap 目录就位、字体回退这几件事：
 *    任何一环断了，画面都是**全白且不报错**。
 * 4. **静态资源真的在产物里** —— `public/pdfjs/` 被 Vite 复制进 `out/renderer/`。
 *    漏了这一步的症状同样是「中文 PDF 一片空白」，而不是构建失败。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机现在**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。所以这里也只启动一次。
 *
 * 断言刻意**不依赖文案**：i18n 的默认语言受 userData 影响，断言中文或英文都会变成
 * 「单跑绿、全跑红」那类脆弱用例（AGENTS.md 记过这个 locale 陷阱）。翻页判据用
 * `canvas[data-page-number]` 与按钮的 `disabled`，两者都与文案无关。
 */

// fixture 生成器在 `fixtures/documents.ts` —— P3-10 需要第三种字体编法的 PDF
// （CMap 编码、无 ToUnicode），三份 PDF 与 DOCX 的生成逻辑收拢到一处。
const PDF_PAGE_TEXTS = ['Page 1', 'Page 2'];
const PAGE_COUNT = PDF_PAGE_TEXTS.length;
/** MediaBox 200×200 × BASE_SCALE 1.5 —— 与 `PdfRenderer` 的常量一致，必须精确。 */
const EXPECTED_CANVAS_CSS_WIDTH = 300;

/**
 * 数 canvas 上**真的被画过**的像素。
 *
 * 两个必要的判据，缺一个就会得到假阳性：
 * - **先确认 canvas 有尺寸**。刚挂载时 canvas 是 HTML 默认的 300×150，那时它
 *   一个字节都没画，但下面的循环会照常跑。
 * - **要求 alpha > 0**。canvas 初始是**全零**（透明黑），而「非白」判据
 *   （`data[i] < 250`）会把 `0,0,0` 算成已绘制 —— 于是一张完全空白的 canvas
 *   也能通过「渲染出像素」这条断言。
 */
const COUNT_PAINTED_PIXELS = `(() => {
  const canvas = document.querySelector('.nexus-pdf-canvas');
  if (canvas === null) return -1;
  if (canvas.width <= 1 || canvas.height <= 1) return -2;
  const context = canvas.getContext('2d');
  if (context === null) return -3;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) painted += 1;
  }
  return painted;
})()`;

describe('P3-07 PDF Viewer', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('打开 PDF：真渲染出像素、能翻页、Range 通道与静态资源都就位', async () => {
    const tempDir = createTempDir('nexus-pdf-viewer-');
    const pdfPath = path.join(tempDir, 'spec.pdf');
    fs.writeFileSync(pdfPath, createPdf(PDF_PAGE_TEXTS));

    activeApp = await launchElectronApp({ filePath: pdfPath });
    const app = activeApp;

    // 渲染器的产物出现 —— 外壳这次没有回落占位页，说明登记表查到了 pdf
    await app.waitForSelector('.nexus-pdf-canvas', 30000);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-viewer-placeholder') === null`)
    ).toBe(true);

    // ---- 1. 真的渲染出像素 ----
    // 全白是全链路失败（worker 没起来 / CSP 拦了 / 字节取不到 / 解析失败）的共同症状，
    // 所以判据必须是「有非白像素」，而不是「canvas 存在」。
    await app.waitForFunction(
      `() => { const painted = ${COUNT_PAINTED_PIXELS}; return painted > 0; }`,
      30000
    );

    const painted = await app.evaluate<number>(COUNT_PAINTED_PIXELS);
    expect(painted).toBeGreaterThan(0);

    // ---- 2. canvas 尺寸：逻辑宽度精确，位图宽度按设备像素 ----
    const canvas = await app.evaluate<{
      bitmapWidth: number;
      cssWidth: number;
      devicePixelRatio: number;
      pageNumber: string | null;
    }>(
      `(() => {
        const el = document.querySelector('.nexus-pdf-canvas');
        return {
          bitmapWidth: el.width,
          cssWidth: parseInt(el.style.width, 10),
          devicePixelRatio: window.devicePixelRatio,
          pageNumber: el.dataset.pageNumber ?? null
        };
      })()`
    );

    // 逻辑宽度与 dpr 无关，所以它可以是精确值 —— 这条同时钉住了 BASE_SCALE 与 MediaBox 的换算
    expect(canvas.cssWidth).toBe(EXPECTED_CANVAS_CSS_WIDTH);
    // 位图宽度必须跟着 dpr 走，否则高 DPI 屏上会被拉伸模糊
    expect(canvas.bitmapWidth).toBe(Math.floor(EXPECTED_CANVAS_CSS_WIDTH * canvas.devicePixelRatio));
    expect(canvas.pageNumber).toBe('1');

    // 文件名上 caption，供人核对打开的是哪一份
    expect(await app.getText('.nexus-pdf-name')).toBe('spec.pdf');

    // ---- 3. 翻页：判据用 data-page-number 与 disabled，都不依赖文案 ----
    const pageButtonState = async (): Promise<{ previous: boolean; next: boolean }> =>
      app.evaluate<{ previous: boolean; next: boolean }>(
        `(() => {
          const buttons = document.querySelectorAll('.nexus-pdf-page-button');
          return { previous: buttons[0].disabled, next: buttons[1].disabled };
        })()`
      );

    // 第一页：「上一页」必须 disabled —— 边界状态要如实反映在可交互性上
    expect(await pageButtonState()).toEqual({ previous: true, next: false });

    await app.click('.nexus-pdf-page-button:nth-of-type(2)');
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-canvas')?.dataset.pageNumber === '2'`,
      15000
    );
    expect(await pageButtonState()).toEqual({ previous: false, next: true });
    // 第二页也要真的画出东西 —— 只改页码标签而画面不动，正是「换页没重渲染」的症状
    await app.waitForFunction(
      `() => { const painted = ${COUNT_PAINTED_PIXELS}; return painted > 0; }`,
      15000
    );

    await app.click('.nexus-pdf-page-button:nth-of-type(1)');
    await app.waitForFunction(
      `() => document.querySelector('.nexus-pdf-canvas')?.dataset.pageNumber === '1'`,
      15000
    );
    expect(await pageButtonState()).toEqual({ previous: true, next: false });

    // ---- 4. Range 通道：在真实页面上下文里发一次带 Range 的请求 ----
    // 纯逻辑测试证明的是「我们构造了 206」；这条证明的是「浏览器在 CSP 之下
    // 真的发出了这个请求，并且拿到了 206」—— 两者是不同的东西。
    const rangeResponse = await app.evaluate<{
      status: number;
      contentRange: string | null;
      contentLength: string | null;
      bytes: number;
    }>(
      `(async () => {
        const response = await fetch(${JSON.stringify(toAssetUrl(pdfPath))}, {
          headers: { Range: 'bytes=0-9' }
        });
        const body = await response.arrayBuffer();
        return {
          status: response.status,
          contentRange: response.headers.get('content-range'),
          contentLength: response.headers.get('content-length'),
          bytes: body.byteLength
        };
      })()`
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.bytes).toBe(10);
    expect(rangeResponse.contentLength).toBe('10');
    expect(rangeResponse.contentRange).toMatch(/^bytes 0-9\/\d+$/);

    // 逃逸请求在真机上同样被拒 —— 边界不是只在单测里成立
    const escapeStatus = await app.evaluate<number>(
      `(async () => {
        const response = await fetch('nexus-asset://ws/?path=' + encodeURIComponent('C:/Windows/win.ini'));
        return response.status;
      })()`
    );
    expect(escapeStatus).toBe(403);

    // ---- 5. pdfjs 静态资源真的进了产物 ----
    // 缺 cmaps 的症状是「中文 PDF 一片空白」，不是构建失败 —— 所以必须显式验。
    const cmapResponse = await app.evaluate<{ status: number; bytes: number }>(
      `(async () => {
        const response = await fetch(new URL('./pdfjs/cmaps/UniGB-UCS2-H.bcmap', document.baseURI).href);
        const body = await response.arrayBuffer();
        return { status: response.status, bytes: body.byteLength };
      })()`
    );
    expect(cmapResponse.status).toBe(200);
    expect(cmapResponse.bytes).toBeGreaterThan(0);

    // ---- 6. 加载成功就不该有错误卡；严格只读 ----
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-error-card') === null`)
    ).toBe(true);
    expect(await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)
    ).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.status-dot.readonly') !== null`)
    ).toBe(true);
    expect(await app.getText('.status-format')).not.toBe('Markdown');

    // ---- 7. 懒加载不变量：打开 PDF 只下载 pdfjs，不下载图片/DOCX 渲染器 ----
    const registry = await app.evaluate<{
      registered: string[];
      requested: string[];
      loaded: string[];
    }>(
      `({
        registered: window.nexusViewerRenderers.registeredTypes(),
        requested: window.nexusViewerRenderers.requestedIds(),
        loaded: window.nexusViewerRenderers.loadedIds()
      })`
    );
    expect(registry.registered).toEqual(['image', 'pdf', 'docx']);
    expect(registry.requested).toEqual(['pdf']);
    expect(registry.loaded).toEqual(['pdf']);

    // 附件进的是同一份文档集合，且严格只读
    const documents = await app.evaluate<
      Array<{ kind: string; type: string; filePath: string; readOnly: boolean; hasSession: boolean }>
    >(
      `window.nexusWorkspace.getDocuments().map((d) => ({
        kind: d.kind,
        type: d.type,
        filePath: d.filePath,
        readOnly: d.readOnly,
        hasSession: d.session !== null
      }))`
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual({
      kind: 'viewer',
      type: 'pdf',
      filePath: pdfPath,
      readOnly: true,
      hasSession: false
    });

    // 页数被如实读到 —— PAGE_COUNT 是 fixture 的显式参数，不是猜的
    expect(PAGE_COUNT).toBe(2);
  });
});
