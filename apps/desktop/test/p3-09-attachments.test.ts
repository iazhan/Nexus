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

/**
 * P3-09 的端到端验收：**真实工作区**里的附件确实按类型分到了独立区，并带上元数据。
 *
 * 与 `renderer/test/workspace-sidebar-sections.test.tsx` 的分工：那一条用打桩的
 * `window.nexus` 覆盖渲染分支（含三种空态），跑得快、能造任意输入形状；这一条只证明
 * **真实链路喂进来也是那个结果** —— 扫盘 → 索引 → `listIndexedDocuments()` → 分流 → 渲染。
 * 分类与格式化的规则本身有 26 条单测，这里不重复验。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。所以工作区形状固定成一份，
 * 需要另一种形状（空工作区等）就换一层去测 —— 见上面那条 renderer 用例。
 *
 * ## fixture 为什么带中文文件名
 *
 * 中文文件名是真实使用里的常态，而它经过的每一段（扫盘 dirent → SQLite TEXT →
 * 相对路径 → 侧栏渲染）都可能有编码问题。`原理图.png` 只断言「原样出现在列表里」，
 * **不断言它排第几**：`localeCompare` 不传 locale 时用运行时的默认 locale，
 * 中英混排的先后跟着操作系统走（本机 zh-CN 下汉字排在拉丁字母前）。
 */

/** 3×2 的真实 PNG（与 `p3-06-image-viewer.test.ts` 同一份 fixture）。 */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAIElEQVR42gXBAQEAAAiAIOc4pznN' +
    '6akBYIMdBmuzdmsPcJUKM5Hl0f8AAAAASUVORK5CYII=',
  'base64'
);

/** PDF 的大小：1024 进制下的整数兆，用来验「MB + 不带小数」。 */
const PDF_BYTES = 1024 * 1024;

describe('P3-09 附件管理：侧栏两段与附件元数据', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-attachments-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'index.md'),
      '# 索引\n\n入口文档，见 [[dma]]。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );

    // 两个同名图片落在不同目录 → 侧栏要给出目录提示才能区分
    fs.writeFileSync(path.join(workspace, 'assets', 'logo.png'), PNG_3X2);
    fs.writeFileSync(path.join(workspace, 'logo.png'), PNG_3X2);
    fs.writeFileSync(path.join(workspace, '原理图.png'), PNG_3X2);

    // 大小刻意选成能分辨进制与小数位的样子
    fs.writeFileSync(path.join(workspace, 'datasheet.pdf'), Buffer.alloc(PDF_BYTES, 0x25));
    fs.writeFileSync(path.join(workspace, 'spec.docx'), Buffer.alloc(3000, 0x50));

    // 不在扩展名白名单里 —— 不该出现在侧栏任何一段
    fs.writeFileSync(path.join(workspace, 'ignore.txt'), '不是可索引的文档', 'utf-8');
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

  it('笔记与附件分两段，附件按类型分组并带上大小与同名提示，且只读', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    // 语言钉死成 en-US，断言才不依赖「默认是哪个」。
    // 顺带这也是判据：`workspace.section*` 的 key 若漏了英文条目，
    // 界面会显示 key 原文，下面这条 wait 就会超时。
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);
    await app.waitForFunction(
      `Array.from(document.querySelectorAll('.nexus-sidebar-section-title span:not(.nexus-sidebar-section-count)')).map((el) => el.textContent).join('|') === 'Notes|Attachments'`,
      15000
    );

    const view = await app.evaluate<{
      sections: Array<{
        section: string | null;
        title: string;
        count: string;
        emptyNote: string | null;
        noteFiles: string[];
        groups: Array<{
          label: string;
          count: string;
          expanded: string | null;
          items: Array<{ name: string; hint: string | null; size: string; title: string }>;
        }>;
      }>;
      sidebarText: string;
      inlineEditors: number;
    }>(`(() => {
      const readItems = (group) => {
        const row = group.parentElement;
        return Array.from(row.querySelectorAll('.nexus-attachment-item')).map((item) => ({
          name: item.querySelector('.nexus-tree-name')?.textContent ?? '',
          hint: item.querySelector('.nexus-attachment-hint')?.textContent ?? null,
          size: item.querySelector('.nexus-attachment-size')?.textContent ?? '',
          title: item.getAttribute('title') ?? ''
        }));
      };

      const sections = Array.from(document.querySelectorAll('.nexus-sidebar-section')).map((section) => {
        const head = section.querySelector('.nexus-sidebar-section-title');
        return {
          section: section.getAttribute('data-section'),
          title: head?.querySelector('span:not(.nexus-sidebar-section-count)')?.textContent ?? '',
          count: head?.querySelector('.nexus-sidebar-section-count')?.textContent ?? '',
          emptyNote: section.querySelector('.nexus-sidebar-note')?.textContent ?? null,
          noteFiles: Array.from(section.querySelectorAll('.nexus-tree-file'))
            .filter((el) => !el.classList.contains('nexus-attachment-item'))
            .map((el) => el.querySelector('.nexus-tree-name')?.textContent ?? ''),
          groups: Array.from(section.querySelectorAll('.nexus-attachment-group')).map((group) => ({
            label: group.querySelector('.nexus-tree-name')?.textContent ?? '',
            count: group.querySelector('.nexus-attachment-count')?.textContent ?? '',
            expanded: group.getAttribute('aria-expanded'),
            items: readItems(group)
          }))
        };
      });

      const sidebar = document.querySelector('.nexus-workspace-sidebar');
      return {
        sections,
        sidebarText: sidebar?.textContent ?? '',
        inlineEditors: document.querySelectorAll(
          '.nexus-workspace-sidebar input, .nexus-workspace-sidebar textarea, .nexus-workspace-sidebar [contenteditable="true"]'
        ).length
      };
    })()`);

    // ---- 两段结构 ----
    expect(view.sections.map((section) => section.section)).toEqual(['notes', 'attachments']);

    const [notes, attachments] = view.sections;
    expect(notes!.title).toBe('Notes');
    expect(notes!.count).toBe('2');
    expect(notes!.emptyNote).toBeNull();
    // 笔记段只装 Markdown：顶层目录默认展开，目录排在文件前
    expect(notes!.noteFiles).toEqual(['dma.md', 'index.md']);

    expect(attachments!.title).toBe('Attachments');
    expect(attachments!.count).toBe('5');
    expect(attachments!.emptyNote).toBeNull();
    // 组顺序由 core 的 VIEWER_DOCUMENT_TYPES 定死；空组不出现（这里三类都有）
    expect(attachments!.groups.map((group) => [group.label, group.count])).toEqual([
      ['Image', '3'],
      ['PDF', '1'],
      ['DOCX', '1']
    ]);
    // 默认全部展开 —— 存「收起」而不是「展开」，所以不需要「首次写入默认值」的 effect
    expect(attachments!.groups.map((group) => group.expanded)).toEqual(['true', 'true', 'true']);

    // ---- 大小：1024 进制，但标签用 KB / MB（跟随资源管理器，不跟随 IEC）----
    const [images, pdfs, docxs] = attachments!.groups;
    expect(pdfs!.items.map((item) => [item.name, item.hint, item.size])).toEqual([
      ['datasheet.pdf', null, '1 MB']
    ]);
    expect(docxs!.items.map((item) => [item.name, item.hint, item.size])).toEqual([
      ['spec.docx', null, '2.9 KB']
    ]);

    // ---- 同名提示与中文文件名 ----
    // 用 tooltip 的首行（完整路径）当 key：中文那条的**位置**跟着运行时 locale 走，
    // 按名字取下标会让用例变成「断言这台机器的 ICU」。
    const rowByPath = new Map(
      images!.items.map((item) => [item.title.split('\n')[0], item] as const)
    );
    const assetsLogoPath = path.join(workspace, 'assets', 'logo.png');
    const rootLogoPath = path.join(workspace, 'logo.png');
    const chinesePath = path.join(workspace, '原理图.png');

    const assetsLogo = rowByPath.get(assetsLogoPath)!;
    const rootLogo = rowByPath.get(rootLogoPath)!;
    const chinese = rowByPath.get(chinesePath)!;
    expect(assetsLogo).toBeDefined();
    expect(rootLogo).toBeDefined();
    expect(chinese).toBeDefined();

    // 同名才给目录提示；根目录那个显示 i18n 里的 'root'（不是空串，也不是空白）
    expect([assetsLogo.name, assetsLogo.hint]).toEqual(['logo.png', 'assets']);
    expect([rootLogo.name, rootLogo.hint]).toEqual(['logo.png', 'root']);
    // 中文文件名原样保留，大小照常
    expect([chinese.name, chinese.hint]).toEqual(['原理图.png', null]);
    const pngBytes = fs.statSync(assetsLogoPath).size;
    expect(pngBytes).toBeLessThan(1024); // 前提：下面按「纯字节数、无小数」断言
    expect([assetsLogo.size, chinese.size]).toEqual([`${pngBytes} B`, `${pngBytes} B`]);

    // 同名时按相对路径兜底 → 两条必然相邻（顺序跟着 locale，但相邻性不跟着）
    const logoIndices = images!.items
      .map((item, index) => (item.name === 'logo.png' ? index : -1))
      .filter((index) => index >= 0);
    expect(logoIndices).toHaveLength(2);
    expect(logoIndices[1]! - logoIndices[0]!).toBe(1);

    // ---- tooltip：完整路径 + 修改时间 ----
    const [tooltipPath, tooltipTime] = assetsLogo.title.split('\n');
    expect(tooltipPath).toBe(assetsLogoPath);
    expect(tooltipTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // ---- 白名单外的文件任何一段都不该出现 ----
    expect(view.sidebarText).not.toContain('ignore.txt');

    // ---- 只读：侧栏没有任何内联编辑入口 ----
    expect(view.inlineEditors).toBe(0);

    // ---- 点附件行进的是 Viewer，不是编辑器 ----
    const pngBefore = fs.readFileSync(assetsLogoPath);
    const clicked = await app.evaluate<boolean>(`(() => {
      const item = Array.from(document.querySelectorAll('.nexus-attachment-item')).find((el) =>
        el.querySelector('.nexus-tree-name')?.textContent === 'logo.png' &&
        el.querySelector('.nexus-attachment-hint')?.textContent === 'assets'
      );
      if (!item) return false;
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    expect(clicked).toBe(true);

    await app.waitForSelector('.nexus-image-content', 20000);
    // `naturalWidth > 0` 是「浏览器真拿到了像素」的判据 —— 证明点开的确实是图片渲染器
    await app.waitForFunction(
      `(() => {
        const img = document.querySelector('.nexus-image-content');
        return img !== null && img.naturalWidth > 0;
      })()`,
      15000
    );
    expect(await app.getText('.nexus-image-name')).toBe('logo.png');

    // 严格只读：没有编辑器、没有 Markdown 会话
    expect(await app.evaluate<number>(`document.querySelectorAll('.cm-content').length`)).toBe(0);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)
    ).toBe(true);
    // 打开它没有改动磁盘上的字节
    expect(fs.readFileSync(assetsLogoPath).equals(pngBefore)).toBe(true);
  }, INDEXED_TEST_TIMEOUT_MS);
});
