// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

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

/**
 * 生成一个 ZIP —— **stored（不压缩）** 条目，手写三个结构。
 *
 * 为什么不用现成的 zip 库：DOCX 就是一个 ZIP，而这个用例需要的是**完全可控**的
 * 字节 —— 条目名、内容、是否压缩都由测试决定，出了问题能一眼看出是哪一段。
 * 引一个库只会多一层「它生成的 ZIP 长什么样」的未知。
 *
 * 为什么可以用 stored：ZIP 允许逐条目选择压缩方式，读取方（mammoth 用的 JSZip）
 * 对 stored 条目是原生支持的。省掉 deflate 也省掉了「压缩结果不稳定」这类噪声。
 *
 * 三个结构缺一不可：local file header（每条的元数据 + 数据）、
 * central directory（目录）、EOCD（目录的位置与条目数）。读取方先找 EOCD。
 */
function createZip(entries: ReadonlyArray<readonly [string, Buffer | string]>): Buffer {
  const parts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    const nameBytes = Buffer.from(name, 'utf-8');
    const crc = zlib.crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名为 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方式 0 = stored
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0, 12); // 修改日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小（stored 时等于原大小）
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    parts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 生成方版本
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 条目总数
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  // 注释长度为 0（`alloc` 已经置零）

  return Buffer.concat([...parts, centralDirectory, eocd]);
}

/** 1×1 透明 PNG —— 内嵌图片用，够小且能被浏览器解码。 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/**
 * 生成一份**结构完整**的 DOCX。
 *
 * 刻意用代码生成而不是塞一段 base64：这样 fixture 的来源就是可读的代码，
 * 「标题是哪一级、表格几行几列、有没有内嵌图片」都是显式参数，改断言时
 * 不用去猜「那坨二进制是什么」。
 *
 * 六个刻意的选择，每个都对应一条断言：
 * - **`Heading 1` 样式 + 中文标题** ⟹ 断言 `<h1>` 的文本。mammoth 靠
 *   `word/styles.xml` 里的**样式名**（不是 styleId）识别标题，所以那份文件必须真的给。
 * - **两段中文正文** ⟹ 断言段落结构，且证明 UTF-8 一路没坏。
 * - **一个 `<w:b/>` 的 run** ⟹ 断言 `<strong>`：字符级格式有没有被转换。
 * - **一个未在 styles.xml 里声明的段落样式** ⟹ 逼 mammoth 报 warning，
 *   于是「未还原的内容被如实显示」这条有真机证据（而不是只在单测里用假数据验）。
 * - **2×2 表格** ⟹ 断言 `<table>` 与行列数。表格是 DOCX 里最容易转换出错的块级结构。
 * - **一张内嵌 PNG** ⟹ 断言 `<img>` 的 `src` 是 `data:image/png;base64,…`
 *   且**真的解码出来了**（`naturalWidth > 0`）。这是 `img-src data:` 那条 CSP 的验收。
 */
function createDocx(): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p>
<w:p><w:r><w:t>这是第一段正文。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="TotallyUnknownStyle"/></w:pPr><w:r><w:t>样式未声明的段落。</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗文字</w:t></w:r><w:r><w:t>与普通文字</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>值一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值二</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

  return createZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', documentRels],
    ['word/media/image1.png', ONE_PIXEL_PNG]
  ]);
}

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
