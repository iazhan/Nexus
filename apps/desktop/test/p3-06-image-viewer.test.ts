// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * P3-06 的端到端验收：**图片真的被解码出来了**，而且只加载了图片渲染器。
 *
 * 这是三个 Viewer 里第一个接通真实渲染器的切片，所以这个文件同时验三件事：
 *
 * 1. **资源通道通了** —— `file://` + 当前 CSP 下浏览器能把图片读出来。
 *    判据是 `naturalWidth > 0`：URL 错了、CSP 拦了、文件没了，三者都会让
 *    `<img>` 停在「没解码」状态，而只有真读到像素才会给出非 0 尺寸。
 * 2. **尺寸是对的** —— fixture 刻意用 3×2（宽高不等），宽高写反、被 CSS 缩放
 *    当成显示尺寸、或者读错属性，都会立刻显形。用 1×1 就全都测不出来。
 * 3. **懒加载判据第一次成立** —— P3-05 时一个渲染器都没登记，`requestedIds()`
 *    必然为空，那条断言证明不了任何事。现在打开图片它必须是 `['image']`。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机现在**同一文件里连续启动第 2~3 个 Electron 实例会卡死**（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。
 */

/**
 * 3×2 的真实 PNG（8 位 RGBA、filter 0、无隔行）。
 *
 * 由一次性脚本用 `zlib` 现算出来的，不是从别处拷的 —— 所以它的宽高是**已知且刻意不等**的
 * （3 ≠ 2），下面的断言才有区分度。换成 1×1 的话，「宽高读反」这个 bug 永远测不出来。
 */
const PNG_3X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAIElEQVR42gXBAQEAAAiAIOc4pznN' +
    '6akBYIMdBmuzdmsPcJUKM5Hl0f8AAAAASUVORK5CYII=',
  'base64'
);

const PNG_WIDTH = 3;
const PNG_HEIGHT = 2;

describe('P3-06 图片 Viewer', () => {
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('打开图片：真解码、尺寸正确、只加载图片渲染器', async () => {
    const tempDir = createTempDir('nexus-image-viewer-');
    const pngPath = path.join(tempDir, 'diagram.png');
    fs.writeFileSync(pngPath, PNG_3X2);

    activeApp = await launchElectronApp({ filePath: pngPath });
    const app = activeApp;

    // 渲染器的产物出现 —— 外壳这次没有回落占位页，说明登记表查到了 image
    await app.waitForSelector('.nexus-image-content', 20000);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-viewer-placeholder') === null`)
    ).toBe(true);

    // 等到真的解码完成。`naturalWidth > 0` 是「浏览器拿到了像素」的判据 ——
    // URL 转义错了、CSP 拦了、文件读不到，都会卡在 0 上。
    await app.waitForFunction(
      `(() => {
        const img = document.querySelector('.nexus-image-content');
        return img !== null && img.naturalWidth > 0;
      })()`,
      15000
    );

    const image = await app.evaluate<{
      width: number;
      height: number;
      alt: string;
      src: string;
    }>(
      `(() => {
        const img = document.querySelector('.nexus-image-content');
        return {
          width: img.naturalWidth,
          height: img.naturalHeight,
          alt: img.getAttribute('alt'),
          src: img.getAttribute('src')
        };
      })()`
    );

    // 尺寸必须等于 fixture 的真实像素，且**不能把宽高写反**
    expect(image.width).toBe(PNG_WIDTH);
    expect(image.height).toBe(PNG_HEIGHT);
    // 图片没显示出来时 alt 是唯一信息
    expect(image.alt).toBe('diagram.png');
    // 走的是 file://（§10.4 定案 A），路径按 URL 规则转义过
    expect(image.src.startsWith('file:///')).toBe(true);
    expect(image.src.endsWith('/diagram.png')).toBe(true);

    // 状态栏把真实尺寸报出来 —— 这也是「图片尺寸正确」在界面上可核对的形式
    expect(await app.getText('.nexus-image-size')).toBe(`${PNG_WIDTH} × ${PNG_HEIGHT}`);
    expect(await app.getText('.nexus-image-name')).toBe('diagram.png');

    // 加载成功就不该有错误卡
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-error-card') === null`)
    ).toBe(true);

    // 严格只读：没有编辑器，也没有 Markdown 会话
    expect(await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-editor-full') === null`)
    ).toBe(true);

    // ---- 懒加载不变量：这一次它终于是真判据 ----
    // 打开图片 ⟹ 图片渲染器的 chunk 被请求了；而它是**唯一**被请求的。
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
    expect(registry.requested).toEqual(['image']);
    expect(registry.loaded).toEqual(['image']);
  });
});
