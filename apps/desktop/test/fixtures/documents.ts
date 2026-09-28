import zlib from 'node:zlib';

/**
 * 测试用的**文档 fixture 生成器**（P3-07 / P3-08 / P3-10 共用）。
 *
 * ## 为什么是代码生成而不是内联 base64
 *
 * 三份 PDF 与一份 DOCX 的**来源都是可读的代码**：页数、页面尺寸、每页文字、字体
 * 编法、文档结构都是显式参数，改断言时不用去猜「那坨二进制是什么」。P3-07 与
 * P3-08 原本各自带着一份生成器，P3-10 需要第三种 PDF（CMap 编码）时把它们收拢到这里
 * —— 同一个「手写 ZIP」逻辑出现三遍，改一处忘一处是静默的。
 *
 * ## 三份 PDF 的差别只有字体编法
 *
 * | 生成器 | 字体 | 需要外部 cmap？ |
 * | --- | --- | --- |
 * | `createPdf` | Type1 / Helvetica（WinAnsi） | 否（只有 ASCII） |
 * | `createCjkPdf` | Type0 + `/Identity-H` + **自带 ToUnicode** | 否 |
 * | `createCmapEncodedCjkPdf` | Type0 + `/UniGB-UCS2-H`，**无 ToUnicode** | **是** |
 *
 * 后两者的差别不是「中文 / 英文」，而是**提取中文时要不要外部的 cmap 文件**。
 * P3-10 的提取器必须配 `cMapUrl` 就是因为第三行 —— 不配时 pdfjs 提不出任何东西
 * 且只打一条 warning（见 `electron/processor/pdf-text.ts`）。
 */

// ── ZIP / DOCX ──────────────────────────────────────────────────────────────

/**
 * 生成一个 ZIP —— **stored（不压缩）** 条目，手写三个结构。
 *
 * 为什么不用现成的 zip 库：DOCX 就是一个 ZIP，而测试需要的是**完全可控**的
 * 字节 —— 条目名、内容、是否压缩都由测试决定，出了问题能一眼看出是哪一段。
 * 引一个库只会多一层「它生成的 ZIP 长什么样」的未知。
 *
 * 为什么可以用 stored：ZIP 允许逐条目选择压缩方式，读取方（mammoth 用的 JSZip）
 * 对 stored 条目是原生支持的。省掉 deflate 也省掉了「压缩结果不稳定」这类噪声。
 *
 * 三个结构缺一不可：local file header（每条的元数据 + 数据）、
 * central directory（目录）、EOCD（目录的位置与条目数）。读取方先找 EOCD。
 */
export function createZip(entries: ReadonlyArray<readonly [string, Buffer | string]>): Buffer {
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
export const ONE_PIXEL_PNG = Buffer.from(
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
export function createDocx(): Buffer {
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

/** 只有文字、没有任何结构的 DOCX —— P3-10 的文本提取用例用，断言里不必绕开表格与图片。 */
export function createPlainDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('\n');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>\n${body}\n</w:body></w:document>`;

  return createZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['word/document.xml', document]
  ]);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/**
 * 把一组对象拼成一份**结构完整**的 PDF（含真算出来的 xref 表）。
 *
 * xref 是**真算出来**的（不是省掉让阅读器容错重建）：spike 用的那份缺 xref 也能
 * 被 pdfjs 接受，但那会让「PDF 解析失败」和「xref 缺失」两种原因纠缠在一起。
 */
function buildPdf(objects: readonly string[]): Buffer {
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const entryCount = objects.length; // 含 0 号自由条目
  pdf += `xref\n0 ${entryCount}\n0000000000 65535 f \n`;
  for (let number = 1; number < entryCount; number += 1) {
    pdf += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${entryCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * 一份 ASCII 文本的多页 PDF（Type1 / Helvetica）。
 *
 * 两个刻意的选择（对应 P3-07 的断言）：
 * - **MediaBox 200×200、scale 1.5 ⟹ 逻辑宽度正好 300px**。300 是精确值，
 *   于是「canvas 尺寸算错」这类 bug 会立刻显形，而不是靠一个范围断言糊过去。
 * - **每页画不同的字**（`Page 1` / `Page 2`），翻页后像素会变 —— 这是「换页真的
 *   重新渲染了」而不是「只是把页码标签改了」的判据。
 */
export function createPdf(pageTexts: readonly string[]): Buffer {
  const escapeText = (text: string): string => text.replace(/([\\()])/g, '\\$1');

  // 对象号布局：1=Catalog、2=Pages、3+2i=第 i 页、4+2i=第 i 页内容流、末位=字体
  const fontObjectNumber = 3 + pageTexts.length * 2;
  const objects: string[] = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] ` +
    `/Count ${pageTexts.length} >>`;

  pageTexts.forEach((text, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const stream = `BT /F1 24 Tf 24 140 Td (${escapeText(text)}) Tj ET`;

    objects[pageObjectNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
      `/Contents ${contentObjectNumber} 0 R >>`;
    objects[contentObjectNumber] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontObjectNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  return buildPdf(objects);
}

/** UTF-16BE 的十六进制码位 —— Type0 字体的内容流用这个写法。 */
function utf16beHex(text: string): string {
  return Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase();
}

const CID_FONT_DESCRIPTOR =
  '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 ' +
  '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 ' +
  '/CapHeight 880 /StemV 93 >>';

const CID_FONT =
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> ' +
  '/FontDescriptor 7 0 R /DW 1000 >>';

/**
 * 单页 CJK PDF 的公共对象（1=Catalog 2=Pages 3=Page 4=Contents 5=Font 6=CIDFont 7=Descriptor）。
 *
 * ## MediaBox 按文本长度算出来 —— 这不是凑数
 *
 * `getTextContent()` **会把落在 MediaBox 之外的字丢掉**（实测：24pt 的 10 个汉字放进
 * 200×200 的框里只提得出 8 个；同样的内容放进 2000×2000 就全提得出）。所以 fixture
 * 的框必须装得下要断言的字，否则会得到一条看起来像「提取器截断文本」的假失败 ——
 * 我第一次写这个 fixture 就踩了。
 *
 * 真实 PDF 几乎不受影响（正文都在页面内），但这条对 P3-11 有意义：**页外的东西
 * 本来就取不到文本**，那不是 bug。
 */
function cjkPageObjects(text: string, fontObject: string): string[] {
  const objects: string[] = [];
  // 每个汉字 1em = 24pt（`/DW 1000`），左边距 24pt，再留一点余量
  const pageWidth = 24 * (text.length + 4);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';

  const stream = `BT /F1 24 Tf 24 140 Td <${utf16beHex(text)}> Tj ET`;
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 200] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  objects[5] = fontObject;
  objects[6] = CID_FONT;
  objects[7] = CID_FONT_DESCRIPTOR;
  return objects;
}

/**
 * 中文单页 PDF：Type0 + `/Identity-H` + **自带 ToUnicode**。
 *
 * 码位就是 UTF-16BE，ToUnicode 把每个码位映回它自己。于是「码位 → Unicode」
 * 不依赖任何外部文件 —— 这是最常见的一种中文 PDF（能复制出文字的 PDF 都长这样）。
 */
export function createCjkPdf(text: string): Buffer {
  const objects = cjkPageObjects(
    text,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H ' +
      '/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>'
  );

  const codes: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = utf16beHex(text).slice(index * 4, index * 4 + 4);
    codes.push(`<${code}> <${code}>`);
  }

  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${codes.length} beginbfchar`,
    ...codes,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n');

  objects[8] = `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`;
  return buildPdf(objects);
}

/**
 * 中文单页 PDF：Type0 + `/UniGB-UCS2-H`，**没有 ToUnicode**。
 *
 * 「码位 → Unicode」这一步只能靠 pdfjs 外部的 `UniGB-UCS2-H.bcmap`。**不配
 * `cMapUrl` 时 pdfjs 会返回 0 个文本项、一个字都提不出来**（只打一条 warning），
 * 于是这份文件在界面上会显示成「未提取到文本」—— 一份明明有字的 PDF 被如实告知
 * 「没有文本」。P3-10 的提取器配 `cMapUrl` 就是为了这一行。
 */
export function createCmapEncodedCjkPdf(text: string): Buffer {
  return buildPdf(
    cjkPageObjects(
      text,
      '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ' +
        '/DescendantFonts [6 0 R] >>'
    )
  );
}
