// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * P3-05 的端到端验收：**没有渲染器的类型回落占位页**，且只读文档进的是
 * 同一份文档集合（不是 App 里另立的状态）。
 *
 * P3-01 验的是「启动参数 → viewer 模式」这条契约；这里验的是它接进框架之后的样子。
 *
 * ## 为什么这个文件用的是 PDF 而不是图片
 *
 * 「占位页」覆盖的是「类型已识别，但当前构建没打包它的渲染器」这个状态 ——
 * 而它天生是个**会移动的目标**：每接一个渲染器，就少一个能触发它的类型。
 * P3-05 时所有类型都走占位页；P3-06 注册图片渲染器后轮到 pdf / docx；
 * P3-07 注册 PDF 后只剩 docx。所以这个文件每过一个切片就要换一次 fixture，
 * 换的正是「当时第一个还没有渲染器的类型」。
 *
 * 这么做还顺带把懒加载判据变成了**真的判据**：打开一个非图片文档时，
 * `requestedIds()` 必须为空 —— 图片渲染器的 chunk 一个字节都不该被下载。
 * 在此之前（一个渲染器都没登记时）这个断言是恒真的，证明不了任何事。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机现在**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。所以这里也只启动一次。
 *
 * 断言刻意**不依赖文案**：i18n 的默认语言受 userData 影响，断言中文或英文都会变成
 * 「单跑绿、全跑红」那类脆弱用例（AGENTS.md 记过这个 locale 陷阱）。
 */

/**
 * 最小但**结构完整**的 PDF。
 *
 * 这份 fixture 的内容不参与断言（viewer 不读附件内容），但刻意写成真的 PDF 而不是
 * 一堆垃圾字节：P3-07 要接 PDF 渲染器时会需要一个真文件，那时把它换成带正文与
 * 中文字体的样本即可，而不是从这里开始猜「原来那个空文件是干嘛的」。
 * 缺 xref 表，但主流阅读器与 pdfjs 都能容错重建 —— P3-07 会用真样本替换。
 */
const MINIMAL_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
    'endobj',
    'trailer',
    '<< /Size 4 /Root 1 0 R >>',
    '%%EOF',
    ''
  ].join('\n'),
  'utf8'
);

/** 文档集合里那份文档的最小形状 —— 只需要它来断言 kind / type / 只读性。 */
interface DocumentSummary {
  kind: string;
  type: string;
  filePath: string | null;
  saveState: string;
  readOnly: boolean;
  hasSession: boolean;
}

describe('P3-05 viewer 外壳与只读文档', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('没有渲染器的类型回落占位页，且不会去下载别的渲染器', async () => {
    const tempDir = createTempDir('nexus-viewer-surface-');
    const pdfPath = path.join(tempDir, 'spec.pdf');
    fs.writeFileSync(pdfPath, MINIMAL_PDF);

    activeApp = await launchElectronApp({ filePath: pdfPath });
    const app = activeApp;

    // 外壳存在，且如实标出类型 —— 这是「ViewerSurface 拿到了正确的描述对象」的证据
    await app.waitForSelector('.nexus-viewer-placeholder', 20000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-viewer-placeholder')?.dataset.viewerType ?? ''`
      )
    ).toBe('pdf');
    expect(await app.getText('.nexus-workspace-empty-path')).toBe(pdfPath);

    // 占位**不是错误**：类型已识别，只是这个构建还没打包它的渲染器
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-error-card') === null`)
    ).toBe(true);

    // 也不是可编辑文档 —— viewer 是严格只读的
    expect(await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)
    ).toBe(true);

    // 状态栏必须如实说是只读，而且格式标签不能写着 Markdown
    // （`.status-dot` 的色调类来自 SAVE_STATE_TONE，与文案同源）
    expect(
      await app.evaluate<boolean>(`document.querySelector('.status-dot.readonly') !== null`)
    ).toBe(true);
    expect(await app.getText('.status-format')).not.toBe('Markdown');

    // ---- 懒加载不变量（验收第 6 条）----
    // P3-06 起图片渲染器已登记，但这一份是 PDF：登记的**不等于**要下载的。
    // `requested` 为空 ⟺ 图片渲染器的 chunk 一个字节都没读 —— 这就是按需加载的定义。
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
    expect(registry.registered).toEqual(['image']);
    expect(registry.requested).toEqual([]);
    expect(registry.loaded).toEqual([]);

    // ---- Tab 集成：附件进的是**同一份**文档集合 ----
    // DOM 上看不出来（只有一个文档时标签栏不渲染），所以直接问状态层。
    const documents = await app.evaluate<DocumentSummary[]>(
      `window.nexusWorkspace.getDocuments().map((d) => ({
        kind: d.kind,
        type: d.type,
        filePath: d.filePath,
        saveState: d.saveState,
        readOnly: d.readOnly,
        hasSession: d.session !== null
      }))`
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual({
      kind: 'viewer',
      type: 'pdf',
      filePath: pdfPath,
      saveState: 'readonly',
      readOnly: true,
      // 附件没有 session —— 给了只会造出「能改但没地方去」的假象
      hasSession: false
    });
  });
});
