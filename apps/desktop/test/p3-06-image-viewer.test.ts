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
 * 1. **资源通道通了** —— `nexus-asset://` + 当前 CSP 下浏览器能把图片读出来。
 *    （P3-06 时走的是 `file://`；P3-07 改到自定义协议，理由见 §5.1 的变更记录 ——
 *    http 页面加载不了 `file://` 子资源，dev 下图片会全部打不开。）
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
    // 走的是 nexus-asset://，路径按 URL 规则转义过（`D:` → `D%3A`、`/` → `%2F`）
    expect(image.src.startsWith('nexus-asset://')).toBe(true);
    expect(image.src).toContain('diagram.png');

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
    // P3-07 起 `registered` 里多了 pdf、P3-08 起多了 docx —— 登记了三个
    // 而只请求了一个，正是「登记是急切的、加载是懒的」这句话的字面证据。
    // 这条断言从此**不再随切片变动**：三个 viewer 类型在 P3-08 全部登记完毕。
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
    expect(registry.requested).toEqual(['image']);
    expect(registry.loaded).toEqual(['image']);

    // ---- 浏览能力：缩放 / 棋盘格底 / 文件大小 ----
    //
    // 平移（放大后能不能滚到溢出部分）在这里**验不了** —— fixture 是 3×2 的图，
    // 放到 300% 也只有 9×6 像素，永远不溢出。它靠下面那两条 `getComputedStyle`
    // 断言守着：`safe center` 是「溢出时从左上角开始、能滚到」的全部要点，
    // 而光秃秃的 `center` 会把左半边推到滚动区外且滚不回去。

    // 打开即「适合窗口」—— 3×2 的图在任何窗口里都放得下，所以 fit 会被上限夹到 300%。
    // 这一条同时钉住「默认不是 100%」：若默认值是 100%，这里会读到 '100'。
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-image-zoom-level').value`)
    ).toBe('300');
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-image-viewer').getAttribute('data-zoom')`
      )
    ).toBe('300');

    // 「实际大小」是一个显式动作，不是默认态
    await app.evaluate<void>(`document.querySelector('[data-zoom-action="actual"]').click()`);
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-image-zoom-level').value`)
    ).toBe('100');

    // 棋盘格底：`background-image` 上是渐变，而不是一块随主题变的单色
    expect(
      await app.evaluate<string>(
        `getComputedStyle(document.querySelector('.nexus-image-stage')).backgroundImage`
      )
    ).toContain('linear-gradient');

    // 溢出时能滚到 —— 见上面那段说明
    expect(
      await app.evaluate<string>(
        `getComputedStyle(document.querySelector('.nexus-image-stage')).justifyContent`
      )
    ).toBe('safe center');

    // 文件大小走资源通道的 HEAD（`content-length`）。取不到就不显示，
    // 所以这一条同时证明「通道通」与「面板真的把它渲染出来了」。
    await app.waitForSelector('.nexus-image-bytes', 10000);
    expect(await app.getText('.nexus-image-bytes')).toMatch(/\d/);

    // 相对路径相对工作区根显示。轻量模式（裸启动打开一个文件）下 `citationBase` 是
    // 文档所在目录，算出来与文件名相同 → 那一项**不该**出现。
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-image-path') === null`)
    ).toBe(true);
  });
});
