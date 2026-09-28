// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createProcessorRegistry } from '../electron/processor/index.js';
import {
  createCjkPdf,
  createCmapEncodedCjkPdf,
  createDocx,
  createPdf,
  createPlainDocx
} from './fixtures/documents.js';

/**
 * P3-10 的提取验收：**真的从字节里提出了字**。
 *
 * 这个文件**不启动 Electron** —— 提取是纯 Node 的事（主进程侧的 pdfjs legacy build
 * 与 mammoth 的 Node 入口），把它塞进真机用例只会让它慢 100 倍还更难定位。
 * 启动 Electron 的端到端链路另有 `p3-10-extraction-index.test.ts`。
 *
 * ## 三条只有真解析才能验的事
 *
 * 1. **中文真的提得出来** —— 而中文字体有两种编法，行为完全不同（见下）。
 * 2. **`cMapUrl` 配对了** —— 这是本切片唯一一个「配错了会静默返回空文本」的配置。
 * 3. **坏文件不会把整次索引带崩** —— 提取失败必须收成 `failed` 而不是往上抛。
 *
 * 断言**不依赖文案**（错误消息只验「非空」）：i18n 与 pdfjs 的措辞都会变，
 * 钉死它们只会制造脆弱用例。
 */

const registry = createProcessorRegistry();

function extract(documentType: 'pdf' | 'docx' | 'image', buffer: Buffer, relativePath: string) {
  return registry.extract(documentType, { relativePath, bytes: new Uint8Array(buffer) });
}

describe('createProcessorRegistry', () => {
  it('登记了 PDF 与 DOCX 两个处理器，图片没有', () => {
    expect(registry.list().map((processor) => processor.id)).toEqual(['pdf-text', 'docx-text']);
    expect(registry.find('pdf')?.id).toBe('pdf-text');
    expect(registry.find('docx')?.id).toBe('docx-text');
    // 图片没有处理器是**有意**的：图片里没有文本，而 OCR 是 Phase 5
    expect(registry.find('image')).toBeNull();
    expect(registry.find('markdown')).toBeNull();
  });

  it('每次装配拿到的是独立实例（测试之间不串味）', () => {
    expect(createProcessorRegistry()).not.toBe(createProcessorRegistry());
  });
});

describe('PDF 文本提取', () => {
  it('提出 ASCII 正文', async () => {
    const outcome = await extract('pdf', createPdf(['Hello PDF']), 'a.pdf');
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('Hello PDF');
  });

  it('多页都提，且按页序', async () => {
    const outcome = await extract('pdf', createPdf(['Page 1', 'Page 2']), 'a.pdf');
    expect(outcome.status).toBe('extracted');
    expect(outcome.text.indexOf('Page 1')).toBeLessThan(outcome.text.indexOf('Page 2'));
  });

  it('提出中文 —— Identity-H + ToUnicode（不依赖外部 cmap 的编法）', async () => {
    const outcome = await extract('pdf', createCjkPdf('从站配置与分布式时钟'), 'zh.pdf');
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('从站配置与分布式时钟');
  });

  it('提出中文 —— UniGB-UCS2-H 且**没有** ToUnicode（这条钉住 cMapUrl 配置）', async () => {
    // 这份 fixture 的「码位 → Unicode」只能靠 pdfjs 外部的 `UniGB-UCS2-H.bcmap`。
    // 提取器一旦漏配 `cMapUrl`，pdfjs 会返回 0 个文本项、只打一条 warning，
    // 于是这份文件被判成「未提取到文本」——**一个安静的错误答案**。
    // 所以这条断言是 `pdf-text.ts` 里那段资源路径存在的唯一证据。
    const outcome = await extract('pdf', createCmapEncodedCjkPdf('缓存一致性'), 'zh-cmap.pdf');
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('缓存一致性');
  });

  it('没有文本层时如实报 empty（扫描版 PDF 的形态）', async () => {
    const outcome = await extract('pdf', createPdf(['']), 'scan.pdf');
    expect(outcome.status).toBe('empty');
    expect(outcome.text).toBe('');
    // 不是失败：Phase 3 明确不做 OCR，所以「提不到」就是提不到
    expect(outcome.message).toBeUndefined();
  });

  it('坏字节收成 failed，不往上抛', async () => {
    const outcome = await extract('pdf', Buffer.from('这根本不是 PDF'), 'broken.pdf');
    expect(outcome.status).toBe('failed');
    expect(outcome.text).toBe('');
    expect(typeof outcome.message).toBe('string');
    expect((outcome.message ?? '').length).toBeGreaterThan(0);
  });

  it('空字节也收成 failed', async () => {
    const outcome = await extract('pdf', Buffer.alloc(0), 'empty.pdf');
    expect(outcome.status).toBe('failed');
  });
});

/**
 * `copyForPdfjs()` 的守卫。
 *
 * 这三条**刻意绕开上面的 `extract()` helper** —— helper 里的 `new Uint8Array(buffer)`
 * 顺手就把 `Buffer` 转成了普通 `Uint8Array`，正好把要验的两个问题都掩盖掉。
 * 这里走 `indexer` 的真实路径：把 `FileService` 读出来的东西原样递进去。
 *
 * 修之前这两个问题都会**静默**发生：第一个抛错但错误消息只有 pdfjs 自己看得懂，
 * 第二个连错都不报 —— 调用方事后才发现自己的字节没了。
 */
describe('输入字节的形态与所有权', () => {
  it('直接传 Buffer 也能提（FileService 读出来就是 Buffer，而 pdfjs 在 Node 下明确拒绝它）', async () => {
    const buffer = createPdf(['Buffer Guard']);
    expect(Buffer.isBuffer(buffer)).toBe(true);

    const outcome = await registry.extract('pdf', { relativePath: 'a.pdf', bytes: buffer });
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('Buffer Guard');
  });

  it('调用后调用方手里的字节完好（pdfjs 会 transfer 走输入的 ArrayBuffer）', async () => {
    const bytes = new Uint8Array(createPdf(['Transfer Guard']));
    const lengthBefore = bytes.byteLength;

    const outcome = await registry.extract('pdf', { relativePath: 'a.pdf', bytes });

    expect(outcome.status).toBe('extracted');
    // 不复制的话这里是 0：pdfjs 走 LoopbackPort + structuredClone(obj, { transfer })
    expect(bytes.byteLength).toBe(lengthBefore);
    expect(Buffer.from(bytes).toString('latin1')).toContain('%PDF');
  });

  it('同一份字节连着提两次都成（复用输入不会第二次变成「坏 PDF」）', async () => {
    const bytes = new Uint8Array(createPdf(['Reuse Guard']));

    const first = await registry.extract('pdf', { relativePath: 'a.pdf', bytes });
    const second = await registry.extract('pdf', { relativePath: 'a.pdf', bytes });

    expect(first.status).toBe('extracted');
    expect(second.status).toBe('extracted');
    expect(second.text).toContain('Reuse Guard');
  });
});

describe('DOCX 文本提取', () => {
  it('提出中文正文', async () => {
    const outcome = await extract(
      'docx',
      createPlainDocx(['标题一', '这是第一段正文。']),
      'a.docx'
    );
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('标题一');
    expect(outcome.text).toContain('这是第一段正文。');
  });

  it('表格单元格里的文字也在（纯文本提取不看结构，但不该漏内容）', async () => {
    const outcome = await extract('docx', createDocx(), 'a.docx');
    expect(outcome.status).toBe('extracted');
    expect(outcome.text).toContain('标题一');
    expect(outcome.text).toContain('列一');
    expect(outcome.text).toContain('值二');
  });

  it('空文档报 empty', async () => {
    const outcome = await extract('docx', createPlainDocx([]), 'empty.docx');
    expect(outcome.status).toBe('empty');
  });

  it('坏字节收成 failed', async () => {
    const outcome = await extract('docx', Buffer.from('not a zip'), 'broken.docx');
    expect(outcome.status).toBe('failed');
    expect((outcome.message ?? '').length).toBeGreaterThan(0);
  });
});

describe('注册表与处理器的分工', () => {
  it('没有处理器的类型返回 none，且不去碰字节', async () => {
    const outcome = await extract('image', Buffer.from('PNG'), 'a.png');
    expect(outcome).toEqual({ status: 'none', text: '' });
  });
});
