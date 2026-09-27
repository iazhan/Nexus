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
 * P3-01 的端到端验收：非 Markdown 文档要进 viewer 模式，而不是「不支持的文件」错误页。
 *
 * 验的是**契约的贯通**，不是渲染：main 的 `parseLaunchArgs` 判出类型 → IPC 送到
 * renderer → `App` 走 viewer 分支。
 *
 * 断言标记刻意选**外壳**（`.nexus-viewer-surface` + `data-viewer-type`）而不是某个
 * 渲染器的产物：外壳对每一种 viewer 文档都存在，而渲染器会随切片换
 * （P3-06 图片 / P3-07 PDF / P3-08 DOCX 各自接入，还会在没打包渲染器时回落占位页）。
 * 用 `.nexus-viewer-placeholder` 或 `.nexus-image-content` 当标记，每接一个渲染器
 * 这个文件就要改一次 —— 而它测的明明是「启动参数走对了分支」这件事。
 *
 * 「图片渲染正确（尺寸、懒加载）」那一层在 `p3-06-image-viewer.test.ts`。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机现在**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测）：
 * `fetch /json/list` 已经返回 200、WebSocket 也 `open` 了，但紧接着的
 * `Runtime.enable` 永不返回，而 harness 的 `sendCommand` 没有超时 → 用例卡满
 * `testTimeout`。对照实验里 `history-save.test.ts`（5 次启动）同样卡住，说明是
 * **环境性退化，与本切片无关**。仓库里 39 个 desktop 测试文件有 33 个只启动一次，
 * 所以这里也只用一次 —— 覆盖的是「启动参数 → viewer 模式」这条链路，
 * 而 `pdf` / `docx` / 图片走的是**同一个分支**，类型映射另有 core 单测兜底
 * （`packages/core/test/document-extensions.test.ts`）。
 *
 * 断言刻意**不依赖文案**。i18n 的默认语言受 userData 影响，断言中文或英文都会变成
 * 「单跑绿、全跑红」那类脆弱用例（AGENTS.md 记过这个 locale 陷阱）。
 * 所以这里只断言结构：路径元素、以及「不是错误页、也不是可编辑文档」。
 */

/** 1×1 透明 PNG。内容不参与断言，但写一个**真的** PNG，别留个假的给后续切片。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

describe('P3-01 viewer mode wiring', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('opens an image into viewer mode instead of the unsupported-file error', async () => {
    const tempDir = createTempDir('nexus-viewer-');
    const pngPath = path.join(tempDir, 'diagram.png');
    fs.writeFileSync(pngPath, PNG_1X1);

    activeApp = await launchElectronApp({ filePath: pngPath });
    const app = activeApp;

    // 外壳认领了它，并且**类型是从启动参数推出来的**（不是默认值、不是猜的）。
    // 若 viewer 分支没生效，图片会落到「不支持的文件」错误页（改这个功能之前的行为），
    // 那时 `.nexus-error-card` 会出现、`.nexus-viewer-surface` 不存在，下面两条就会红。
    await app.waitForSelector('.nexus-viewer-surface', 20000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-viewer-surface')?.dataset.viewerType ?? ''`
      )
    ).toBe('image');

    // 不是「不支持的文件」错误页
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-error-card') === null`)
    ).toBe(true);

    // 也没有可编辑文档 —— viewer 是严格只读的，不该建 Markdown 会话。
    // 白名单里的非 Markdown 文档同理，另由 core 的 launch-parser 单测覆盖。
    expect(
      await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)
    ).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)
    ).toBe(true);
  });
});
