// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';
import {
  createCjkPdf,
  createCmapEncodedCjkPdf,
  createPdf,
  createPlainDocx
} from './fixtures/documents.js';

/**
 * P3-10 的端到端验收：**被 Markdown 引用过的附件，正文进得了全文索引**。
 *
 * 与 `p3-10-processors.test.ts` 的分工：那一条在纯 Node 里验「处理器真的从字节里
 * 提出了字」（快、能造坏文件）；这一条只证明**真实链路喂进来也是那个结果** ——
 * 扫盘 → 解析引用 → 挑出被引用的附件 → 主进程提取 → 写库 → 搜索能命中 → 界面标出类型。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测）。
 * 所以工作区形状固定成一份，四种「提取状态」一次全造齐。
 *
 * ## 为什么搜索词都不出现在笔记里
 *
 * `index.md` 的链接文字刻意写成「手册甲 / 手册乙」这种与内容无关的词。否则搜到了
 * 分不清是**笔记命中**还是**附件正文命中** —— 而这一条要验的正是后者。
 *
 * ## 为什么两个中文 PDF 用了不同的字体编法
 *
 * `datasheet.pdf` 是 Identity-H + 自带 ToUnicode，`cjk.pdf` 是 UniGB-UCS2-H 且
 * **没有** ToUnicode。后者只有 `cMapUrl` 配对了才提得出来，而 `cMapUrl` 指向的是
 * `pdfjs-dist` 包内的资源目录 —— **打包之后这个路径还对不对，只有真机能回答**。
 * 所以这一条是「打包产物里 cmap 资源仍然可达」的唯一证据。
 */

describe('P3-10 附件文本提取：被引用的附件进全文索引', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-extraction-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });

    // 引用集合由这一篇决定：datasheet / cjk / scan / spec 被引用，orphan 没有
    fs.writeFileSync(
      path.join(workspace, 'index.md'),
      '# 索引\n\n' +
        '见 [手册甲](docs/datasheet.pdf)、[手册乙](docs/cjk.pdf)、[手册丙](docs/scan.pdf)，' +
        '规格见 [[spec.docx]]。\n',
      'utf-8'
    );

    // Identity-H + 自带 ToUnicode：基本的中文提取
    fs.writeFileSync(path.join(workspace, 'docs', 'datasheet.pdf'), createCjkPdf('从站配置'));
    // UniGB-UCS2-H 且没有 ToUnicode：**只有配了 cMapUrl 才提得出来**
    fs.writeFileSync(
      path.join(workspace, 'docs', 'cjk.pdf'),
      createCmapEncodedCjkPdf('缓存一致性')
    );
    // 没有文本层（扫描版 PDF 的形态）→ 被引用，但提取结果是「空」而不是「失败」
    fs.writeFileSync(path.join(workspace, 'docs', 'scan.pdf'), createPdf(['']));
    fs.writeFileSync(
      path.join(workspace, 'docs', 'spec.docx'),
      createPlainDocx(['NebulaRouter 规格'])
    );
    // 没有任何笔记引用它 → 不该被提取，也就搜不到
    fs.writeFileSync(path.join(workspace, 'docs', 'orphan.pdf'), createCjkPdf('孤本标记'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('引用集合决定提取谁，提取出的正文可搜、状态可辨、界面标出类型', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    // 先展开工作区面板 —— 索引（含提取）由它触发
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForIndexReady();

    // 语言钉死成 en-US，界面断言才不依赖「默认是哪个」
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);

    // ── 1. 提取状态：四种状态一次全验 ──────────────────────────────────────
    const statusByPath = new Map(
      await app.evaluate<Array<[string, string]>>(
        `window.nexus.listIndexedDocuments().then((docs) =>
           docs.map((doc) => [doc.relativePath, doc.extractionStatus]))`
      )
    );

    expect(statusByPath.get('docs/datasheet.pdf')).toBe('extracted');
    expect(statusByPath.get('docs/cjk.pdf')).toBe('extracted');
    expect(statusByPath.get('docs/spec.docx')).toBe('extracted');
    // 被引用、但正文里真的没有文本 —— 是「空」，不是「失败」
    expect(statusByPath.get('docs/scan.pdf')).toBe('empty');
    // 没被引用 → 压根没提取过
    expect(statusByPath.get('docs/orphan.pdf')).toBe('none');
    // Markdown 恒为 none：它本身就是文本，不需要提取
    expect(statusByPath.get('index.md')).toBe('none');

    // ── 2. 提取出的正文进了全文索引 ────────────────────────────────────────
    const search = (query: string) =>
      app.evaluate<Array<{ name: string; type: string }>>(
        `window.nexus.searchIndex(${JSON.stringify(query)}).then((hits) =>
           hits.map((hit) => ({ name: hit.name, type: hit.type })))`
      );

    // 「从站」只出现在 datasheet.pdf 的正文里（笔记里没有）—— 命中即证明提取成功
    expect(await search('从站')).toEqual([{ name: 'datasheet.pdf', type: 'pdf' }]);
    // 这一条同时是「打包后 cMapUrl 仍然可达」的证据
    expect(await search('缓存')).toEqual([{ name: 'cjk.pdf', type: 'pdf' }]);
    expect(await search('NebulaRouter')).toEqual([{ name: 'spec.docx', type: 'docx' }]);
    // 没被引用的附件不提取 → 搜不到
    expect(await search('孤本')).toEqual([]);

    // ── 3. 侧栏：只有「本该有文本却没提到」的附件给提示 ─────────────────────
    await app.waitForSelector('.nexus-tree-file[data-attachment="true"]', 15000);

    const sidebarRows = await app.evaluate<Array<[string, string | null, string]>>(`(() => {
      return Array.from(document.querySelectorAll('.nexus-tree-file[data-attachment="true"]')).map((item) => [
        item.querySelector('.nexus-tree-name')?.textContent ?? '',
        item.querySelector('.nexus-attachment-note')?.textContent ?? null,
        item.getAttribute('title') ?? ''
      ]);
    })()`);
    const rowByName = new Map(sidebarRows.map((row) => [row[0], row] as const));

    // 扫描版 PDF：行内短标记 + tooltip 里的完整说法
    expect(rowByName.get('scan.pdf')?.[1]).toBe('no text');
    expect(rowByName.get('scan.pdf')?.[2]).toContain('No text extracted');
    // 提取成功的、没被引用的、以及没有处理器的图片 —— 都不说话
    expect(rowByName.get('datasheet.pdf')?.[1]).toBeNull();
    expect(rowByName.get('cjk.pdf')?.[1]).toBeNull();
    expect(rowByName.get('orphan.pdf')?.[1]).toBeNull();

    // ── 4. 搜索结果带类型徽标 ──────────────────────────────────────────────
    await app.click('.nexus-activity-icon[data-activity="search"]');
    await app.waitForSelector('.nexus-search-input', 10000);

    // React 受控输入要用原生 setter + input 事件，直接改 value 不会触发 onChange
    await app.evaluate(`(() => {
      const input = document.querySelector('.nexus-search-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '从站');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await app.waitForSelector('.nexus-search-hit', 10000);

    const hitRows = await app.evaluate<Array<[string, string | null]>>(`(() => {
      return Array.from(document.querySelectorAll('.nexus-search-hit')).map((row) => [
        row.querySelector('.nexus-search-hit-name')?.textContent ?? '',
        row.querySelector('.nexus-search-hit-badge')?.textContent ?? null
      ]);
    })()`);

    // 徽标是「这个命中来自附件正文，不是笔记」的唯一提示
    expect(hitRows).toEqual([['datasheet.pdf', 'PDF']]);
  }, INDEXED_TEST_TIMEOUT_MS);
});
