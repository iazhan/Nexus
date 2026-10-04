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
 * P3-05 的 Tab 集成验收：**只读附件与可编辑文档共用同一条标签栏**。
 *
 * 这是 P3-05 存在的理由。此前附件是 App 里另立的 `viewerDocument` useState，
 * 刻意「不占用标签页」—— 于是「打开了什么」有两个答案，而标签栏只认识其中一个，
 * 用户双击一个 PDF 之后界面上没有任何痕迹。
 *
 * ## 为什么只有一次 Electron 启动
 *
 * 本机同一文件里连续启动第 2~3 个实例会卡死（2026-09-27 实测，
 * 对照实验见 `p3-01-viewer-mode.test.ts` 的文件头注释）。
 *
 * ## 断言不依赖文案
 *
 * 类型靠 `data-document-kind` 区分，而不是靠「哪个标签写着 .png」——
 * 前者是结构，后者在改名、i18n、排序变化时都会碎。
 */

/** 1×1 透明 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** 直接向 window 派发 keydown，而不是用 harness 的 pressKey —— 后者依赖窗口真实聚焦。 */
const pressCtrlP = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, bubbles: true, cancelable: true
    }));
    return true;
  })()`);

/** React 受控输入要用原生 setter + input 事件。 */
const typeQuery = (app: ElectronAppInstance, value: string) =>
  app.evaluate(`(() => {
    const input = document.querySelector('.nexus-quickopen-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const pressEnter = (app: ElectronAppInstance) =>
  app.evaluate(`(() => {
    document.querySelector('.nexus-quickopen-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

/** 按 `data-document-kind` 点标签，不依赖顺序。 */
const clickTab = (app: ElectronAppInstance, kind: 'editor' | 'viewer') =>
  app.evaluate(`(() => {
    const tab = document.querySelector('.nexus-tab[data-document-kind="${kind}"]');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);

/**
 * 按**文件名**点文件树里的条目。
 *
 * 不能用 `.nexus-tree-file` 取第一个 —— 附件从 P3-04 起也进了索引，而文件树
 * 是从索引建的，所以 `diagram.png` 会排在 `dma.md` 前面。取第一个就变成了
 * 「点了一个 PNG 却等编辑器」，失败信息还是超时（看起来像功能没做）。
 */
const clickTreeFile = (app: ElectronAppInstance, name: string) =>
  app.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.nexus-tree-file'))
      .find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
    if (!item) return false;
    item.click();
    return true;
  })()`);

describe('P3-05 标签栏：附件与可编辑文档并存', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-viewer-tabs-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'dma.md'),
      '# DMA\n\n控制器支持多通道传输。\n\n见 [[diagram.png]]。\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(workspace, 'diagram.png'), PNG_1X1);
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

  it('附件作为标签页打开，且与可编辑文档可以来回切换', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();

    // 先打开一份 Markdown：标签栏常驻，所以此时就已经有一条。
    // 按**名字**点，不取第一个 —— 附件也在树里，且 `diagram.png` 排在 `dma.md` 前。
    expect(await clickTreeFile(app, 'dma.md')).toBe(true);
    await app.waitForSelector('.cm-content', 20000);
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-tab').length`)).toBe(1);

    // 再用快速打开取附件。候选来自索引 —— 而索引从 P3-04 起收附件，
    // 所以这一条同时验证了「P3-04 的附件索引」与「P3-05 的打开分流」接得上。
    await pressCtrlP(app);
    await app.waitForSelector('.nexus-quickopen-input', 10000);
    await typeQuery(app, 'diagram');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-quickopen-item').length === 1`,
      5000
    );
    await pressEnter(app);

    // 附件被打开成 viewer：外壳出现，编辑器消失。
    // 用**外壳**而不是某个渲染器的产物当标记：本文件测的是「两类文档共用一条标签栏」，
    // 与「图片用什么渲染」无关 —— 后者在 `p3-06-image-viewer.test.ts`。
    await app.waitForSelector('.nexus-viewer-surface', 20000);
    expect(await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)).toBe(true);
    expect(await app.evaluate<boolean>(`document.querySelector('.nexus-error-card') === null`)).toBe(
      true
    );

    // 附件的 `saveState` 也是 `readonly`，但「只读 Markdown，可以另存为」那条横幅
    // **不能**出现在 PDF / 图片上 —— 它会让用户以为「另存为一下就能编辑这个 PDF」。
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-banner-saveas-btn') === null`)
    ).toBe(true);

    // 标签栏现在有两条，且两类各一条 —— 这是「附件进的是同一份集合」的直接证据
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-tab').length`)).toBe(2);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-tab[data-document-kind="viewer"]').length`
      )
    ).toBe(1);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-tab[data-document-kind="editor"]').length`
      )
    ).toBe(1);

    // 切回 Markdown：编辑器必须回来，且内容还是那一份
    expect(await clickTab(app, 'editor')).toBe(true);
    await app.waitForSelector('.cm-content', 20000);
    expect(
      await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)
    ).toContain('多通道传输');
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-viewer-surface') === null`)
    ).toBe(true);

    // 再切回附件：外壳必须回来（而不是留在编辑器上）
    expect(await clickTab(app, 'viewer')).toBe(true);
    await app.waitForSelector('.nexus-viewer-surface', 20000);
    expect(await app.evaluate<boolean>(`document.querySelector('.cm-content') === null`)).toBe(true);

    // 从**文件树**点同一个附件：激活既有的 viewer 标签页，而不是开出第二份。
    // 文件树是从索引建的，附件自 P3-04 起就在索引里 —— 所以这条路径是 P3-04
    // 顺带得到的，而 P3-05 的打开分流让它真的能用（此前点它只会报「不支持的格式」）。
    expect(await clickTreeFile(app, 'diagram.png')).toBe(true);
    await app.waitForSelector('.nexus-viewer-surface', 20000);
    expect(
      await app.evaluate<number>(`window.nexusWorkspace.getDocuments().length`)
    ).toBe(2);

    // 关掉附件标签：剩下的可编辑文档必须还在，且不凭空多出一份
    await app.evaluate(`(() => {
      document.querySelector('.nexus-tab[data-document-kind="viewer"] .nexus-tab-close').click();
      return true;
    })()`);
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-tab').length === 1`,
      10000
    );
    expect(
      await app.evaluate<number>(`window.nexusWorkspace.getDocuments().length`)
    ).toBe(1);
    expect(
      await app.evaluate<string>(`window.nexusWorkspace.getDocuments()[0].kind`)
    ).toBe('editor');
    // 关掉附件后活动文档应当落到相邻的那个，而不是空集合
    await app.waitForSelector('.cm-content', 20000);
  }, INDEXED_TEST_TIMEOUT_MS);
});
