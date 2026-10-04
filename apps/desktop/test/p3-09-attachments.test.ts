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
 * P3-09 的端到端验收：**真实工作区**里的附件在文件树里与笔记混排，并带上元数据。
 *
 * 「显示图片」那个开关只藏**图片**，PDF / DOCX 照常显示 —— 这一条是本文件里
 * 最容易被写松的判据，所以正反两面都断言。
 *
 * ## 2026-10-01：布局从「两段」改回「单树」
 *
 * 这个文件原来断言的是「笔记树 + 附件区」两段（`.nexus-sidebar-section` 的
 * `data-section="notes|attachments"`）。**那个布局已经取消** —— 附件与笔记现在是同一棵
 * 树里的节点，按目录结构混排，由工具栏的一个开关控制可见性。理由与两个参考实现的对照
 * 见 `docs/workspace-redesign-plan.md`。
 *
 * 所以这里断言的东西整体换了：从「分到哪一段、按类型分成哪几组」换成
 * 「在不在这棵树里、元数据对不对、开关管不管用」。仍然只启动**一次** Electron ——
 * 本机同一文件里连续启动第 2~3 个实例会卡死（见 `p3-01-viewer-mode.test.ts` 头注释）。
 *
 * 与 `renderer/test/workspace-sidebar-tree.test.tsx` 的分工：那一条用打桩的
 * `window.nexus` 覆盖渲染分支（空态、禁用矩阵、重名预检），跑得快、能造任意输入形状；
 * 这一条只证明**真实链路喂进来也是那个结果** —— 扫盘 → 索引 → 列目录 → 建树 → 渲染。
 */

/** 3×2 的真实 PNG（与 `p3-06-image-viewer.test.ts` 同一份 fixture）。 */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAIElEQVR42gXBAQEAAAiAIOc4pznN' +
    '6akBYIMdBmuzdmsPcJUKM5Hl0f8AAAAASUVORK5CYII=',
  'base64'
);

/** PDF 的大小：1024 进制下的整数兆，用来验「MB + 不带小数」。 */
const PDF_BYTES = 1024 * 1024;

describe('P3-09 附件管理：单树里的附件与元数据', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-attachments-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
    // 空目录：索引里没有它，只有「列目录」那条通道能看见
    fs.mkdirSync(path.join(workspace, '素材'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'index.md'), '# 索引\n\n入口文档，见 [[dma]]。\n', 'utf-8');
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );
    // 两层深：给「全部展开 / 收起」一个能看出差别的形状 ——
    // 只有一层的话，展开与收起在界面上完全没有区别。
    fs.mkdirSync(path.join(workspace, 'notes', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes', 'deep', 'a.md'), '# A\n', 'utf-8');

    fs.writeFileSync(path.join(workspace, 'assets', 'logo.png'), PNG_3X2);
    fs.writeFileSync(path.join(workspace, '原理图.png'), PNG_3X2);

    // 大小刻意选成能分辨进制与小数位的样子
    fs.writeFileSync(path.join(workspace, 'datasheet.pdf'), Buffer.alloc(PDF_BYTES, 0x25));
    fs.writeFileSync(path.join(workspace, 'spec.docx'), Buffer.alloc(3000, 0x50));

    // 不在扩展名白名单里 —— 不该出现在树里
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

  it('笔记、附件、空目录在同一棵树里，附件带大小，点开进 Viewer 而不是编辑器', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForIndexReady();

    // 语言钉死成 en-US，断言才不依赖「默认是哪个」。
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);
    await app.waitForSelector('.nexus-workspace-toolbar', 15000);

    const view = await app.evaluate<{
      sectionCount: number;
      rows: Array<{
        kind: string;
        relativePath: string;
        attachment: string | null;
        selected: string | null;
        name: string;
        size: string;
        title: string;
      }>;
      toolbar: string[];
      sidebarText: string;
      inlineEditors: number;
    }>(`(() => {
      const rows = Array.from(document.querySelectorAll('.nexus-workspace-sidebar [data-relative-path]')).map((row) => ({
        kind: row.getAttribute('data-tree-kind') ?? '',
        relativePath: row.getAttribute('data-relative-path') ?? '',
        attachment: row.getAttribute('data-attachment'),
        selected: row.getAttribute('data-selected'),
        name: row.querySelector('.nexus-tree-name')?.textContent ?? '',
        size: row.querySelector('.nexus-attachment-size')?.textContent ?? '',
        title: row.getAttribute('title') ?? ''
      }));

      const sidebar = document.querySelector('.nexus-workspace-sidebar');
      return {
        sectionCount: document.querySelectorAll('.nexus-sidebar-section').length,
        rows,
        // **必须限定在侧栏那一栏里**：编辑器工具栏（nexus-editor-toolbar）复用同一套
        // .nexus-toolbar-button 样式，全窗口选会把它的 undo/redo 一并数进来。
        // 这条断言问的是「侧栏工具栏有哪几个动作」，不是「窗口里所有按钮」。
        toolbar: Array.from(
          document.querySelectorAll('.nexus-workspace-toolbar .nexus-toolbar-button')
        ).map((button) => button.getAttribute('data-action') ?? ''),
        sidebarText: sidebar?.textContent ?? '',
        inlineEditors: document.querySelectorAll(
          '.nexus-workspace-sidebar input, .nexus-workspace-sidebar textarea, .nexus-workspace-sidebar [contenteditable="true"]'
        ).length
      };
    })()`);

    // ---- 单树：不再有「段」这个东西 ----
    expect(view.sectionCount).toBe(0);

    const byPath = new Map(view.rows.map((row) => [row.relativePath, row] as const));

    // ---- 目录来自磁盘列举，所以**空目录也在树里**（索引里没有它）----
    expect(byPath.get('素材')?.kind).toBe('directory');
    expect(byPath.get('assets')?.kind).toBe('directory');
    expect(byPath.get('notes')?.kind).toBe('directory');

    // ---- 笔记与附件在同一棵树里，且附件被标出来 ----
    expect(byPath.get('index.md')?.attachment).toBe('false');
    expect(byPath.get('notes/dma.md')?.attachment).toBe('false');
    expect(byPath.get('assets/logo.png')?.attachment).toBe('true');
    expect(byPath.get('原理图.png')?.attachment).toBe('true');
    expect(byPath.get('datasheet.pdf')?.attachment).toBe('true');

    // ---- 附件行带大小：1024 进制，但标签用 KB / MB（跟随资源管理器，不跟随 IEC）----
    expect(byPath.get('datasheet.pdf')?.size).toBe('1 MB');
    expect(byPath.get('spec.docx')?.size).toBe('2.9 KB');
    const pngBytes = fs.statSync(path.join(workspace, 'assets', 'logo.png')).size;
    expect(pngBytes).toBeLessThan(1024); // 前提：下面按「纯字节数、无小数」断言
    expect(byPath.get('assets/logo.png')?.size).toBe(`${pngBytes} B`);

    // ---- tooltip：完整路径 + 修改时间 ----
    const [tooltipPath, tooltipTime] = (byPath.get('assets/logo.png')?.title ?? '').split('\n');
    expect(tooltipPath).toBe(path.join(workspace, 'assets', 'logo.png'));
    expect(tooltipTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // ---- 白名单外的文件不该出现 ----
    expect(view.sidebarText).not.toContain('ignore.txt');

    // ---- 工具栏六枚按钮都在（树里有图片、也有目录，所以两个开关都在）----
    expect(view.toolbar).toEqual([
      'new-file',
      'new-folder',
      'delete',
      'toggle-images',
      'toggle-expand',
      'refresh'
    ]);

    // ---- 一键展开 / 收起 ----
    //
    // 默认只展开顶层，所以 `notes/deep` 这一行看得见、它下面的 `a.md` 看不见。
    expect(byPath.has('notes/deep')).toBe(true);
    expect(byPath.has('notes/deep/a.md')).toBe(false);

    const clickToolbar = (action: string) =>
      app.evaluate<boolean>(`(() => {
        const button = document.querySelector('.nexus-toolbar-button[data-action="${action}"]');
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
    const treePaths = () =>
      app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-workspace-sidebar [data-relative-path]'))
          .map((row) => row.getAttribute('data-relative-path') ?? '')`
      );

    expect(await clickToolbar('toggle-expand')).toBe(true);
    await app.waitForFunction(
      `document.querySelector('.nexus-toolbar-button[data-action="toggle-expand"]')
        ?.getAttribute('data-expanded') === 'true'`,
      15000
    );
    expect(await treePaths()).toContain('notes/deep/a.md');

    expect(await clickToolbar('toggle-expand')).toBe(true);
    await app.waitForFunction(
      `document.querySelector('.nexus-toolbar-button[data-action="toggle-expand"]')
        ?.getAttribute('data-expanded') === 'false'`,
      15000
    );
    // 收起之后连顶层也收了 —— 「全部收起」就是全部
    expect(await treePaths()).not.toContain('notes/deep/a.md');
    expect(await treePaths()).not.toContain('notes/deep');

    // 再展开回来：下面的用例要点 `assets/logo.png`，而它现在被收在 `assets/` 里。
    // 收在这里不还原的话，后面的失败会表现为「找不到那一行」—— 那是上一段留下的状态，
    // 不是被测代码坏了。
    expect(await clickToolbar('toggle-expand')).toBe(true);
    await app.waitForFunction(
      `document.querySelector('.nexus-toolbar-button[data-action="toggle-expand"]')
        ?.getAttribute('data-expanded') === 'true'`,
      15000
    );

    // ---- 只读：没在新建/改名时，侧栏没有任何输入控件 ----
    expect(view.inlineEditors).toBe(0);

    // ---- 点附件行进的是 Viewer，不是编辑器 ----
    const logoPath = path.join(workspace, 'assets', 'logo.png');
    const pngBefore = fs.readFileSync(logoPath);
    const clicked = await app.evaluate<boolean>(`(() => {
      const row = document.querySelector('.nexus-workspace-sidebar [data-relative-path="assets/logo.png"]');
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    expect(await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)).toBe(
      true
    );
    // 打开它没有改动磁盘上的字节
    expect(fs.readFileSync(logoPath).equals(pngBefore)).toBe(true);

    // ---- 「显示图片」开关只藏图片，PDF / DOCX 留着 ----
    const readTree = () =>
      app.evaluate<{ paths: string[]; shown: string | null; showAll: boolean }>(`(() => ({
        paths: Array.from(document.querySelectorAll('.nexus-workspace-sidebar [data-relative-path]'))
          .map((row) => row.getAttribute('data-relative-path') ?? ''),
        shown: document.querySelector('.nexus-toolbar-button[data-action="toggle-images"]')
          ?.getAttribute('data-shown') ?? null,
        showAll: document.querySelector('[data-action="show-all"]') !== null
      }))()`);

    const before = await readTree();
    expect(before.shown).toBe('true');
    expect(before.paths).toContain('assets/logo.png');

    await app.evaluate(
      `(() => {
        document.querySelector('.nexus-toolbar-button[data-action="toggle-images"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`
    );

    await app.waitForFunction(
      `document.querySelector('.nexus-toolbar-button[data-action="toggle-images"]')
        ?.getAttribute('data-shown') === 'false'`,
      15000
    );

    const hidden = await readTree();
    // 图片没了
    expect(hidden.paths).not.toContain('assets/logo.png');
    expect(hidden.paths).not.toContain('原理图.png');
    // **PDF / DOCX 留着** —— 这个开关的意图是「树被图淹了」，而它们通常正是要找的东西。
    // 一起藏起来只会让人以为文件丢了。
    expect(hidden.paths).toContain('datasheet.pdf');
    expect(hidden.paths).toContain('spec.docx');
    // 笔记还在
    expect(hidden.paths).toContain('index.md');
    // **只含图片的目录跟着消失**（否则用户看到一个空目录，而里面其实有图），
    // 而**本来就空**的目录留着（用户正要往里放东西）
    expect(hidden.paths).not.toContain('assets');
    expect(hidden.paths).toContain('素材');
    // 还没到「全被藏光」的地步，所以不出现那条出路
    expect(hidden.showAll).toBe(false);

    // 再点一次回来
    await app.evaluate(
      `(() => {
        document.querySelector('.nexus-toolbar-button[data-action="toggle-images"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`
    );
    await app.waitForFunction(
      `document.querySelector('.nexus-toolbar-button[data-action="toggle-images"]')
        ?.getAttribute('data-shown') === 'true'`,
      15000
    );

    expect((await readTree()).paths).toContain('assets/logo.png');
  }, INDEXED_TEST_TIMEOUT_MS);
});
