// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';
import { createDocx } from './fixtures/documents.js';

/**
 * P3-08 的端到端验收：**一份真实的 DOCX 被真的解析成了 HTML**，而且
 * Shadow DOM、内嵌图片的 `data:` 通道、严格只读三条都成立。
 *
 * 纯逻辑层（渲染器的状态机、warning 计数、链接拦截）已经在
 * `renderer/test/docx-renderer.test.tsx` 逐条钉死（mammoth 是替身）。
 * 这个文件只验「只有真机 + 真 mammoth 才能验的四件事」：
 *
 * 1. **mammoth 真的能在 Electron 的 renderer 里跑起来** —— 它是 CJS 包，
 *    带 Node 内建依赖（`path` / `url` / `os`），靠 `browser` 字段做替换。
 *    替换漏一条，打包产物里就是 `require("path")` 报错。
 * 2. **Shadow DOM 真的生效** —— 转换结果在 `shadowRoot` 里，而不是宿主 DOM 里。
 * 3. **内嵌图片的 `data:` 真的被 CSP 放行** —— 不放行的症状是「正文完好、
 *    图全是破图」，看起来像那份 DOCX 里的图坏了，不像 CSP 拦了。
 * 4. **严格只读** —— 打开并渲染之后，原文件的 mtime 与内容哈希都不变
 *    （验收第 3 条；图片 / PDF 那两个文件各自验过，这里补上 DOCX）。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。所以这里只启动一次。
 *
 * 断言刻意**不依赖文案**：i18n 的默认语言受 userData 影响，断言中文或英文都会变成
 * 「单跑绿、全跑红」那类脆弱用例（AGENTS.md 记过这个 locale 陷阱）。所以
 * 「有没有未还原的内容」用 `data-docx-warnings` 判，不用提示文字。
 */

// fixture 生成器在 `fixtures/documents.ts`（P3-10 起三份 PDF 与 DOCX 的生成逻辑共用一处）。
/** shadow root 里那份文档的可观测形状。 */
interface DocxView {
  hasShadowRoot: boolean;
  hasStyleTag: boolean;
  headings: string[];
  paragraphs: string[];
  strongText: string | null;
  tableRows: number;
  tableCells: number[];
  imageSrcPrefix: string | null;
  imageComplete: boolean;
  imageNaturalWidth: number;
}

/**
 * 在页面上下文里读 shadow root。
 *
 * 必须写成字符串丢给 `evaluate` —— 页面上下文拿不到测试进程里的任何函数。
 * 用 `?.` 而不是断言：转换还没完成时 `shadowRoot` 就是 null，那时应该**等**，
 * 不是抛错。
 */
const READ_DOCX_VIEW = `(() => {
  const host = document.querySelector('.nexus-docx-content');
  const root = host === null ? null : host.shadowRoot;
  if (root === null) {
    return {
      hasShadowRoot: false, hasStyleTag: false, headings: [], paragraphs: [],
      strongText: null, tableRows: 0, tableCells: [],
      imageSrcPrefix: null, imageComplete: false, imageNaturalWidth: 0
    };
  }
  const img = root.querySelector('img');
  return {
    hasShadowRoot: true,
    hasStyleTag: root.querySelector('style') !== null,
    headings: Array.from(root.querySelectorAll('h1, h2, h3'), (el) => el.textContent),
    paragraphs: Array.from(root.querySelectorAll('p'), (el) => el.textContent),
    strongText: root.querySelector('strong') === null ? null : root.querySelector('strong').textContent,
    tableRows: root.querySelectorAll('table tr').length,
    tableCells: Array.from(root.querySelectorAll('table tr'), (tr) => tr.querySelectorAll('td, th').length),
    imageSrcPrefix: img === null ? null : img.src.slice(0, 22),
    imageComplete: img === null ? false : img.complete,
    imageNaturalWidth: img === null ? 0 : img.naturalWidth
  };
})()`;

describe('P3-08 DOCX Viewer', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('打开 DOCX：真解析成 HTML、Shadow DOM 隔离、内嵌图片走 data:、严格只读', async () => {
    const tempDir = createTempDir('nexus-docx-viewer-');
    const docxPath = path.join(tempDir, '规格说明.docx');
    fs.writeFileSync(docxPath, createDocx());

    // 验收第 3 条的前一半：记下打开前的指纹，最后比对
    const beforeStat = fs.statSync(docxPath);
    const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(docxPath)).digest('hex');

    activeApp = await launchElectronApp({ filePath: docxPath });
    const app = activeApp;

    // 渲染器的产物出现 —— 外壳这次查到了 docx，既没有回落占位页也没有落错误卡
    await app.waitForSelector('.nexus-docx-content', 30000);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-viewer-placeholder') === null`)
    ).toBe(true);

    // ---- 1. 转换真的完成了，而且落在 shadow root 里 ----
    await app.waitForFunction(
      `() => { const host = document.querySelector('.nexus-docx-content');
               return host !== null && host.shadowRoot !== null
                 && host.shadowRoot.querySelector('h1') !== null; }`,
      30000
    );

    const view = await app.evaluate<DocxView>(READ_DOCX_VIEW);

    expect(view.hasShadowRoot).toBe(true);
    // 样式表在边界**内** —— 这是「文档样式不外泄、App 样式不入侵」的物理证据
    expect(view.hasStyleTag).toBe(true);
    // 标题、正文、字符级格式：mammoth 的语义转换确实生效了
    expect(view.headings).toEqual(['标题一']);
    expect(view.paragraphs).toContain('这是第一段正文。');
    expect(view.paragraphs).toContain('样式未声明的段落。');
    expect(view.strongText).toBe('加粗文字');
    // 表格：2 行、每行 2 格
    expect(view.tableRows).toBe(2);
    expect(view.tableCells).toEqual([2, 2]);

    // ---- 2. 内嵌图片走 data:，且真的解码出来了 ----
    // 这两条必须一起断言：`src` 前缀对只能证明 mammoth 转对了，
    // `naturalWidth > 0` 才证明 **CSP 放行了 `data:`**（被拦时 naturalWidth 是 0，
    // 而正文完好 —— 看起来像「那份 DOCX 里的图坏了」）。
    expect(view.imageSrcPrefix).toBe('data:image/png;base64,');
    expect(view.imageComplete).toBe(true);
    expect(view.imageNaturalWidth).toBeGreaterThan(0);

    // 文件名上 caption
    expect(await app.getText('.nexus-docx-name')).toBe('规格说明.docx');

    // ---- 3. 未还原的内容被如实显示 ----
    // 只用 `data-` 判据，不断言文案：i18n 的默认语言受 userData 影响。
    // 具体条数由单测（mammoth 是替身）钉死，这里只验「有 warning 时确实上界面了」。
    const warnings = await app.evaluate<string>(
      `document.querySelector('.nexus-docx-notice')?.dataset.docxWarnings ?? ''`
    );
    expect(Number(warnings)).toBeGreaterThan(0);

    // ---- 4. 加载成功就不该有错误卡；严格只读 ----
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

    // ---- 5. 懒加载不变量：打开 DOCX 只下载 docx 渲染器 ----
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
    expect(registry.requested).toEqual(['docx']);
    expect(registry.loaded).toEqual(['docx']);

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
      type: 'docx',
      filePath: docxPath,
      readOnly: true,
      hasSession: false
    });

    // ---- 6. 验收第 3 条的后一半：原文件一个字节都没被动过 ----
    const afterStat = fs.statSync(docxPath);
    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(docxPath)).digest('hex');
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterHash).toBe(beforeHash);
  });
});
