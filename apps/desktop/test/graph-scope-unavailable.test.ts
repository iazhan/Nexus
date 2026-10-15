// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * `scope: 'current'` 的**退化路径**：当前文档用不了时，界面必须说出来。
 *
 * ## 为什么单独一个文件
 *
 * 这一组要「两种类型 + 一篇打开着的文档」：类型筛选条只在**两种以上**类型时才画
 * （`typeCounts.length > 1`），而 `graph-panel.test.ts` 的夹具是四篇纯笔记。
 * 往那边塞一个附件会把那个文件里所有节点数、边数、图例断言一起推翻 —— 不值得。
 *
 * ## 为什么非要有这一层
 *
 * `apps/desktop/test/index-store.test.ts` 验的是**主进程**报不报 `centerMissing`，
 * `renderer/test/graph-panel.test.tsx` 验的是**渲染层**拿到它之后禁不禁用按钮 ——
 * 两边用的都是各自的桩。只有真机能证明这两半**对得上**：字段真的过了 IPC、
 * 界面真的在那个时刻禁用了按钮。
 *
 * ## 改动前的症状（这条用例守的就是它）
 *
 * 把当前文档的类型关掉之后，「当前文档」那个按钮**按得动、但按了什么都不发生**：
 * 主进程在筛过的文档里找不到中心，退回全图，而界面照样把按钮画成可用。
 */
describe('图谱范围：当前文档不在图里时', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  const chip = (selector: string) => JSON.stringify(selector);

  const attr = (selector: string, name: string) =>
    app.evaluate<string | null>(
      `document.querySelector(${chip(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`
    );

  const isDisabled = (selector: string) =>
    app.evaluate<boolean>(
      `document.querySelector(${chip(selector)})?.hasAttribute('disabled') ?? false`
    );

  /** 按文件名点开侧栏里的一行 —— `.nexus-tree-file` 是按名字取的，不是「第一个文件」。 */
  const openFile = async (name: string) => {
    await app.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.nexus-tree-file'))
        .find((el) => (el.textContent ?? '').includes(${JSON.stringify(name)}));
      if (!row) throw new Error('文件树里没有 ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`);
    await app.waitForSelector('.cm-content', 20000);
  };

  /**
   * 确保图谱在主区。
   *
   * 打开文档之后主区是编辑器，图谱已经退场 —— 直接点活动栏图标才谈得上点控制条。
   * 先探一下是因为那个图标是**切换**：已经显示着再点一次会把它收起来。
   */
  const ensureGraphVisible = async () => {
    const present = await app.evaluate<boolean>(
      `!!document.querySelector('.nexus-main-content .nexus-graph-canvas')`
    );
    if (present) return;
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-main-content .nexus-graph-canvas', 20000);
    // 重新挂载之后要先查一次图、算一次布局，`data-nodes` 才有内容
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.nodes !== '[]'`,
      20000
    );
  };

  const countsAre = (nodes: string, links: string) =>
    app.waitForFunction(
      `document.querySelector('.nexus-graph [data-count="nodes"]')?.textContent === '${nodes} nodes' &&
       document.querySelector('.nexus-graph [data-count="links"]')?.textContent === '${links} links'`,
      10000
    );

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-scope-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    /*
      note → other → third 一条链，外加一个**不连任何东西**的附件。
      附件只为凑出第二种类型（筛选条），它不进任何一条边 ——
      于是「关掉笔记」之后图上只剩它一个孤立点，裁剪与否一目了然。
    */
    fs.writeFileSync(path.join(workspace, 'note.md'), '# 笔记\n\n参见 [[other]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'other.md'), '# 其他\n\n参见 [[third]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'third.md'), '# 第三\n\n终点。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'manual.pdf'), '%PDF-1.4 占位', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('关掉当前文档的类型后，「当前文档」被禁用并退回全图', async () => {
    // 活动文档必须是笔记 —— 关掉「笔记」这个类型才会把它自己藏掉
    await openFile('note.md');
    await ensureGraphVisible();

    // 先确认范围真的切过去了：4 个点 → 3 个（manual.pdf 谁也不连，不在两跳之内）
    await app.click('.nexus-graph-chip[data-scope="current"]');
    await countsAre('3', '2');
    expect(await attr('.nexus-graph-chip[data-scope="current"]', 'aria-pressed')).toBe('true');

    // 关掉「笔记」：当前文档自己的类型没了
    await app.click('.nexus-graph-chip[data-type="markdown"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-chip[data-type="markdown"]')?.getAttribute('aria-pressed') === 'false'`,
      10000
    );

    /*
      三条一起验，缺一条这个缺陷都能从旁边溜过去：
      - 退回全图（不然界面说的和画的不一致）；
      - 按钮禁用（不然用户还能按到一个没反应的按钮 —— 这就是原来的症状）；
      - 说明原因（禁用而不说为什么，等于把「没反应」换成「灰掉了」）。
    */
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-chip[data-scope="all"]')?.getAttribute('aria-pressed') === 'true'`,
      10000
    );
    expect(await isDisabled('.nexus-graph-chip[data-scope="current"]')).toBe(true);

    const title = await attr('.nexus-graph-chip[data-scope="current"]', 'title');
    expect(title).toContain('not in the graph');
    // 用户明明开着文档，不能说「请先打开一份文档」
    expect(title).not.toContain('Open a document');

    // 筛选生效了：笔记全被藏掉，只剩那个附件
    await countsAre('1', '0');
  }, INDEXED_TEST_TIMEOUT_MS);

  it('把类型放回来之后，「当前文档」恢复可用', async () => {
    /*
      反例侧：少了这条，「一直禁用」也能过上面那一条。
      禁用必须**跟着条件走**，不是一次性关掉。
    */
    await ensureGraphVisible();

    await app.click('.nexus-graph-chip[data-type="markdown"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-chip[data-type="markdown"]')?.getAttribute('aria-pressed') === 'true'`,
      10000
    );

    expect(await isDisabled('.nexus-graph-chip[data-scope="current"]')).toBe(false);
    expect(await attr('.nexus-graph-chip[data-scope="current"]', 'title')).toBeNull();

    // 恢复之后**不会**自己跳回「当前文档」—— 范围是用户的选择，只是当时给不了
    expect(await attr('.nexus-graph-chip[data-scope="all"]', 'aria-pressed')).toBe('true');
    await countsAre('4', '2');
  }, INDEXED_TEST_TIMEOUT_MS);
});
