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
 * 标签面板。
 *
 * 标签来自索引（磁盘内容），不是编辑器草稿。扫描判据的 38 条单测在
 * `packages/core/test/tags.test.ts`、查询的 7 条在 `test/tags.test.ts`、
 * 面板渲染分支的 4 条在 `renderer/test/tags-panel.test.tsx`，
 * 这里验接进 App 之后的整条链路，含 Ctrl+点击编辑器里的标签。
 */
describe('标签面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-tags-e2e-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // a.md 刻意写长、标签放**中间**：前后都要有足够内容，「滚到视口第一行」才验得出来
    // —— 目标离文末不足一屏时滚动会被钳制在最大值，行盒反而落在视口下方。
    const filler = (label: string, count: number) =>
      Array.from({ length: count }, (_, index) => `- ${label} ${index + 1}`).join('\n');
    fs.writeFileSync(
      path.join(workspace, 'a.md'),
      `# A\n\n${filler('上面', 30)}\n\n讲 #dma 和 #ethercat。\n\n${filler('下面', 30)}\n`,
      'utf-8'
    );
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n也讲 #dma。\n', 'utf-8');
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

  it('列出标签与文档数，展开后能看到文档并打开', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    // 等索引建好 —— 标签依赖它
    await app.waitForIndexReady();

    await app.click('.nexus-activity-icon[data-activity="tags"]');

    // 先看 IPC 层拿到了什么 —— 区分「索引里没标签」和「面板没渲染」
    const tagsFromIpc = await app.evaluate<string>(
      `window.nexus.listTags().then((tags) => JSON.stringify(tags))`
    );

    try {
      await app.waitForSelector('.nexus-tag-item', 20000);
    } catch (err) {
      const panelDump = await app.evaluate<string>(
        `document.querySelector('.nexus-tags')?.textContent ?? '(面板不存在)'`
      );
      throw new Error(
        `标签列表没渲染。IPC 返回: ${tagsFromIpc} / 面板内容: ${panelDump} / 原始错误: ${
          err instanceof Error ? err.message : err
        }`
      );
    }

    const rows = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-tag-item')).map((el) => el.textContent ?? '')`
    );
    // 按标签名排序：dma 在 ethercat 前
    expect(rows[0]).toContain('#dma');
    expect(rows[0]).toContain('2');
    expect(rows[1]).toContain('#ethercat');
    expect(rows[1]).toContain('1');

    // 点 #dma 展开它下面的文档
    await app.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.nexus-tag-item'));
      items.find((el) => el.textContent?.includes('dma'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.nexus-tag-documents .nexus-backlink-item', 15000);

    const documents = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-tag-documents .nexus-backlink-item'))
         .map((el) => el.textContent)`
    );
    expect(documents).toEqual(['a.md', 'b.md']);

    // 点文档 → 打开
    await app.click('.nexus-tag-documents .nexus-backlink-item');
    await app.waitForSelector('.cm-content', 20000);

    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('a.md');

    // ── 打开的同时，文档里那个标签被滚到视口第一行 ──
    //
    // 与大纲跳转同一条落点路径（`revealHeadingAt`）。这里只验结果，不验实现：
    // 标签行的顶边要和滚动容器的顶边对齐。
    await app.waitForFunction(
      `() => {
        const tag = document.querySelector('.cm-nexus-tag[data-tag="dma"]');
        const scroller = document.querySelector('.cm-scroller');
        if (!tag || !scroller) return false;
        return Math.abs(tag.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 4;
      }`,
      15000
    );

    // 而且要**真的滚过**：文档本来就贴着顶时，上面那条断言同样成立。
    expect(
      await app.evaluate<number>(`document.querySelector('.cm-scroller')?.scrollTop ?? 0`)
    ).toBeGreaterThan(0);

    // ── Ctrl+点击编辑器里的标签 → 标签面板切过去并展开它 ──
    //
    // 这一段验的是 App 层那条分支：编辑器只把 `kind: 'tag'` 与归一化后的标签名递出来，
    // 「往哪去」由宿主决定。它是这条链路上唯一没有单测覆盖的一环 ——
    // 编辑器侧只验到「navigator 收到了请求」（`packages/editor/test/tag-highlight.test.ts`）。
    //
    // 此时面板正展开着 #dma，所以断言「切到 ethercat」同时验了**切换**。
    await app.waitForSelector('.cm-nexus-tag', 20000);
    await app.evaluate(`(() => {
      const tag = Array.from(document.querySelectorAll('.cm-nexus-tag'))
        .find((el) => el.dataset.tag === 'ethercat');
      if (!tag) throw new Error('编辑器里没有 #ethercat 的高亮');
      tag.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0, ctrlKey: true
      }));
      return true;
    })()`);

    await app.waitForFunction(
      `document.querySelector('.nexus-tag-item-active')?.textContent?.includes('ethercat') === true`,
      15000
    );

    // ethercat 只在 a.md 里
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-tag-documents .nexus-backlink-item'))
           .map((el) => el.textContent)`
      )
    ).toEqual(['a.md']);
  }, INDEXED_TEST_TIMEOUT_MS);
});
