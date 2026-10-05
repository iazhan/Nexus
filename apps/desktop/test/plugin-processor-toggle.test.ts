// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PDF_TEXT_PROCESSOR_ID } from '@nexus/core';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';
import { createPdf, createPlainDocx } from './fixtures/documents.js';

/**
 * 主进程文档处理器启停的真机闭环（P1-4b）。
 *
 * ## 它验的是 P1-4a 那条链路验不到的那一半
 *
 * 渲染进程内那 5 个能力（`plugin-capability-toggle.test.ts`）关掉一个只需要一个谓词 ——
 * 值就在渲染进程的存档里，谁用谁读。文档处理器不一样：**它住在主进程**，
 * 而「用户在设置里关掉了什么」存在渲染进程的 localStorage 里，主进程读不到。
 * 所以这一条验的是**整条跨进程链**：设置窗口写盘 → 渲染进程推 `syncHostSettings`
 * → 主进程缓存 → 索引时查表 → 提取真的没跑。
 *
 * 三层各自只盖住一段：`host-settings.test.ts`（两侧）证明「值送出去了、收下了、现读」；
 * `processor-registry.test.ts` 证明「谓词一改，`find()` 立刻变」；这里把三段接起来 ——
 * 任何一段断了，症状都是同一个：**开关点了什么都不会发生**。
 *
 * ## 两条断言，用的是两条不同的路
 *
 * 提取是**有缓存**的：`extractReferencedAttachments` 跳过任何 `extractionStatus !== 'none'`
 * 的附件（`indexer.ts` 的「跳过判据」一节，有意为之：几百页的手册不该每轮重读）。
 * 所以要看到「提取这一遍真的没跑」，得让某个附件**状态回到 `none`**，有两条路：
 *
 * 1. **同一个进程里重跑**（第一次启动的后半段）：把 `doc.pdf` 的内容换掉 →
 *    附件的 `contentHash` 是 stat 指纹（size + mtime）→ `upsertDocument` 把它的
 *    `extraction_status` 重置回 `'none'` → 下一次索引**会**试着提取它。此时若开关真的
 *    送到了主进程，它就不该提出任何东西。这一步顺带钉住「**改设置不用重启**」——
 *    哨兵变量还在，说明渲染进程没换过。
 * 2. **换一个工作区重来**（第二次启动）：全新的索引库，提取从头跑一遍。
 *    这一步顺带钉住「**关掉再打开 Nexus，禁用状态还在**」（两次启动共用同一个 `userDataDir`）。
 *
 * 两条路缺一不可：只有 ② 的话，「关掉生效」可能只是因为冷启动重读了一次设置；
 * 只有 ① 的话，验不到落盘。本文件是专用的（一个文件只放这两次启动），符合
 * `memory/build-and-test.md` 里「启动次数 ≥2 的文件独占一批」那条。
 *
 * ## 这一段是修完一个缺陷之后才写得出来的
 *
 * ① 原来跑不通：`indexWorkspace` 只在**指纹变了的文件**上收集引用集合（引用解析在
 * `prepareIndexEntry` 的提前返回之后），而引用来自 **Markdown** —— 只改 PDF 的话引用集合
 * 是空的，`extractReferencedAttachments` 把每个附件都读成「没人引用」并**清空它的正文**，
 * 于是「没被提取」与「被清空了」在断言上分不开。2026-10-05 修掉（`prepareIndexEntry`
 * 不再提前返回，引用集合无条件收集），回归用例在 `index-single-file.test.ts` 的
 * 「重建索引 · 附件正文的提取缓存」一组里，判据 58 记了全过程。
 *
 * ## 判据取搜索命中与提取状态，不取文案
 *
 * `listIndexedDocuments()` 的 `extractionStatus` 是主进程自己报的事实；
 * `searchIndex()` 是**用户视角**的后果（搜得到 / 搜不到）。两者一起用：
 * 状态说明「为什么」，搜索说明「所以呢」。文案一律不断 —— i18n 的默认语言受
 * `userData` 影响，断文案会变成「单跑绿、全跑红」。
 *
 * 搜索词刻意**不出现在笔记里**：否则搜到了分不清是笔记命中还是附件正文命中，
 * 而这一条要验的正是后者。
 */

/** PDF 里的正文标记。`createPdf` 走 Type1 / WinAnsi，只能是 ASCII。 */
const PDF_MARKER = 'AlphaMarker';
/** DOCX 里的正文标记。 */
const DOCX_MARKER = 'BetaMarker';
/**
 * 第一次启动里「换掉 PDF 内容」用的标记。
 *
 * 刻意写得**比 `AlphaMarker` 长**：附件指纹是 `size + mtime`（`attachmentContentFingerprint`），
 * 只改 mtime 的话在文件系统时间精度低的机器上可能不够稳，长度一起变就稳了。
 */
const RECHECK_MARKER = 'GammaMarkerAfterToggle';

describe('主进程处理器启停（P1-4b）', () => {
  let tempDir: string;
  let workspaceA: string;
  let workspaceB: string;
  let userDataDir: string;
  let activeApp: ElectronAppInstance | null = null;

  /** 两个工作区放**同一份内容**：差别只在于「索引是不是从头建的」。 */
  function seedWorkspace(root: string): void {
    fs.mkdirSync(root, { recursive: true });
    // 引用集合由这一篇决定 —— 附件要被引用才会被提取。
    // 链接文字与正文标记无关：搜到的命中只可能来自附件正文。
    fs.writeFileSync(
      path.join(root, 'note.md'),
      '# 引用\n\n见 [甲](doc.pdf) 与 [[doc.docx]]。\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(root, 'doc.pdf'), createPdf([PDF_MARKER]));
    fs.writeFileSync(path.join(root, 'doc.docx'), createPlainDocx([DOCX_MARKER]));
  }

  beforeAll(() => {
    tempDir = createTempDir('nexus-processor-toggle-');
    workspaceA = path.join(tempDir, 'vault-a');
    workspaceB = path.join(tempDir, 'vault-b');
    seedWorkspace(workspaceA);
    seedWorkspace(workspaceB);

    // 显式给 userDataDir：harness 只在没传的时候才自建并删掉，传了就是「要跨启动复用」。
    userDataDir = path.join(tempDir, 'userdata');
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

  /** 存档里那份「被关掉的能力」。判据取存档，不取界面文案。 */
  const readDisabled = (app: ElectronAppInstance) =>
    app.evaluate<string>(`localStorage.getItem('nexus-plugins-disabled') ?? ''`);

  /** 相对路径 → 提取状态。主进程自己报的事实。 */
  const statusByPath = (app: ElectronAppInstance) =>
    app.evaluate<Array<[string, string]>>(
      `window.nexus.listIndexedDocuments().then((docs) =>
         docs.map((doc) => [doc.relativePath, doc.extractionStatus]))`
    );

  /** 搜索命中的文件名。**用户视角的后果** —— 比状态更接近「这件事到底有没有生效」。 */
  const searchNames = (app: ElectronAppInstance, query: string) =>
    app.evaluate<string[]>(
      `window.nexus.searchIndex(${JSON.stringify(query)}).then((hits) => hits.map((hit) => hit.name))`
    );

  /** 打开（或聚焦）设置窗口并停在插件分组。走桥，理由见 `plugin-capability-toggle.test.ts`。 */
  async function openPluginsSettings(app: ElectronAppInstance): Promise<void> {
    await app.evaluate(`window.nexus.openSettingsWindow('plugins')`);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('[data-settings-section="plugins"]', 15000);
  }

  const memberOn = (app: ElectronAppInstance, id: string) =>
    app.evaluate<boolean>(
      `document.querySelector('[data-field-member="plugins.disabled:${id}"]')
         ?.getAttribute('aria-checked') === 'true'`
    );

  /** 拨一下那个成员，并等它真的翻过去。 */
  async function flipMember(app: ElectronAppInstance, id: string): Promise<void> {
    const selector = `[data-field-member="plugins.disabled:${id}"]`;
    const before = await memberOn(app, id);
    await app.click(selector);
    await app.waitForFunction(
      `document.querySelector(${JSON.stringify(selector)})
         ?.getAttribute('aria-checked') === '${String(!before)}'`,
      10000
    );
  }

  /** 回主窗口。等的判据是标题栏（活动栏只在工作区模式里画，见 pitfalls 第 56 条）。 */
  async function backToMain(app: ElectronAppInstance): Promise<void> {
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-header-bar', 15000);
  }

  it('关掉 pdf-text：新索引里 PDF 正文不进、DOCX 照旧进，且设置跨启动还在', async () => {
    // ── 第一次启动：前提 ──────────────────────────────────────────────────
    activeApp = await launchElectronApp({ filePath: workspaceA, userDataDir });
    let app = activeApp;
    await app.waitForIndexReady();

    // 前提：两个处理器都开着时，两边的正文都进了索引。少了这一半，
    // 后面「PDF 搜不到」可能只是因为它从来就没被提取过。
    const before = new Map(await statusByPath(app));
    expect(before.get('doc.pdf')).toBe('extracted');
    expect(before.get('doc.docx')).toBe('extracted');
    expect(await searchNames(app, PDF_MARKER)).toEqual(['doc.pdf']);
    expect(await searchNames(app, DOCX_MARKER)).toEqual(['doc.docx']);

    // ── 关掉 pdf-text ────────────────────────────────────────────────────
    await openPluginsSettings(app);
    // 前提（设置页这侧）：处理器那两个成员确实在开关名单里 —— 名册少一项的症状
    // 就是这个元素根本不存在，而「点了没反应」与「没这个开关」在这里是两种失败。
    expect(await memberOn(app, PDF_TEXT_PROCESSOR_ID)).toBe(true);
    await flipMember(app, PDF_TEXT_PROCESSOR_ID);
    await backToMain(app);
    expect(await readDisabled(app)).toBe(PDF_TEXT_PROCESSOR_ID);

    // ── 同一个进程里重跑一次提取：不用重启就生效 ──────────────────────────
    //
    // 换掉 PDF 的内容 → stat 指纹变了 → `upsertDocument` 把它的 `extraction_status`
    // 重置回 `'none'` → 下一次索引会**试着**提取它。开关真送到了主进程的话，它就不该提出东西。
    //
    // 哨兵：窗口一旦重载，这个变量就没了。它把「改设置本身不重启应用」变成可断言的。
    await app.evaluate(`(() => { window.__nexusProcessorSentinel = 'alive'; return true; })()`);
    fs.writeFileSync(path.join(workspaceA, 'doc.pdf'), createPdf([RECHECK_MARKER]));
    await app.evaluate(`window.nexus.rebuildIndex(${JSON.stringify(workspaceA)})`);

    const recheck = new Map(await statusByPath(app));
    // 正面：处理器被关掉了 —— 提取这一遍跑了但没提出东西，状态停在 `none`
    expect(recheck.get('doc.pdf')).toBe('none');
    expect(await searchNames(app, RECHECK_MARKER)).toEqual([]);
    // 反面（同一次重建里另一个附件）：它没被改过、状态还是 `extracted`，照旧被跳过。
    // 这一条盯的是「关掉 pdf-text 顺手把 docx-text 也关了」与「重建把正文清空了」两种错法 ——
    // 后者是 2026-10-05 修掉的那个缺陷，修之前这一条会红。
    expect(recheck.get('doc.docx')).toBe('extracted');
    expect(await searchNames(app, DOCX_MARKER)).toEqual(['doc.docx']);
    // 反面（进程这侧）：哨兵还在，说明渲染进程没换过 —— 主进程那一份缓存是**现读**的
    expect(await app.evaluate<string | null>(`window.__nexusProcessorSentinel ?? null`)).toBe(
      'alive'
    );

    // **必须优雅关闭**：这个值只在 localStorage 里，SIGTERM 会让 Chromium 来不及刷盘 ——
    // 症状是「下次启动读回来是空的」，看起来像产品 bug。
    await app.closeGracefully();
    activeApp = null;

    // ── 第二次启动：全新工作区、全新索引库 ────────────────────────────────
    activeApp = await launchElectronApp({ filePath: workspaceB, userDataDir });
    app = activeApp;
    await app.waitForIndexReady();

    // 跨启动：设置还在（共用同一个 userDataDir）
    expect(await readDisabled(app)).toBe(PDF_TEXT_PROCESSOR_ID);

    // 正面：PDF 的处理器被关掉了 —— 提取这一遍没跑，状态停在 `none`
    const after = new Map(await statusByPath(app));
    expect(after.get('doc.pdf')).toBe('none');
    // 反面（同一进程里另一个处理器）：DOCX 照旧提取 —— 关一个不能连累另一个
    expect(after.get('doc.docx')).toBe('extracted');

    // 用户视角的后果：PDF 正文搜不到，DOCX 正文照旧搜得到
    expect(await searchNames(app, PDF_MARKER)).toEqual([]);
    expect(await searchNames(app, DOCX_MARKER)).toEqual(['doc.docx']);

    // 笔记本身仍然是索引的一部分 —— 附件被关掉不该让整次索引塌掉
    expect(await searchNames(app, '引用')).toEqual(['note.md']);
  }, INDEXED_TEST_TIMEOUT_MS);
});
