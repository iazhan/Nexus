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
 * 图谱面板。
 *
 * 布局算法本身的单测在 `renderer/test/graph-layout.test.ts`（确定性、坐标边界、
 * 相连节点更近、不贴边），标签避让在 `renderer/test/graph-labels.test.ts`，
 * 视图变换在 `renderer/test/graph-view.test.ts`。
 * 这里验接进 App 之后的链路：索引 → 图 → 画布 → 标签 → 缩放 → 悬停 → 拖拽 → 点击打开。
 *
 * **只启动一次 Electron**（一次 ~7s），四个场景共享同一个实例 —— 它们之间没有状态冲突：
 * 缩放/悬停/拖拽都不改索引，只有「打开文档」会换掉活动文档，而那恰好是最后一个场景要用的前提。
 */
describe('图谱面板', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  interface ScreenNode {
    id: number;
    name: string;
    x: number;
    y: number;
  }

  const readScreenNodes = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes ?? '[]'`)
      .then((raw) => JSON.parse(raw) as ScreenNode[]);

  const readView = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.view ?? '{}'`)
      .then((raw) => JSON.parse(raw) as { scale: number; offsetX: number; offsetY: number });

  const readHover = () =>
    app
      .evaluate<string>(`document.querySelector('.nexus-graph-hitmap')?.dataset.hover ?? '{}'`)
      .then((raw) => JSON.parse(raw) as { id: number | null; neighbors: number[] });

  const byName = (nodes: ScreenNode[], name: string) => nodes.find((node) => node.name === name)!;

  const canvasPoint = (node: { x: number; y: number }) =>
    `(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ${node.x}, y: rect.top + ${node.y} };
    })()`;

  /** 在画布上按下并松开一次（点击）。走 mousedown/mouseup，因为「拖拽不算点击」就靠这两个。 */
  const clickAt = (pointExpression: string) =>
    app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const point = ${pointExpression};
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
    })()`);

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-e2e-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });

    // a → b → c 一条链，外加一篇孤立的
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n参见 [[b]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'b.md'), '# B\n\n参见 [[c]]。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'c.md'), '# C\n\n终点。\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'lonely.md'), '# 孤立\n\n谁也不链。\n', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-graph-canvas', 20000);
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('画出节点、边与标签', async () => {
    /*
      布局比画布晚一帧：画布要等 IPC 回来才渲染，而布局还要等画布尺寸量出来
      （尺寸是 `ResizeObserver` 报的，见 `LAYOUT_SETTLE_MS` 那段）。所以这里要等。
    */
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.nodes !== '[]'`,
      20000
    );

    const nodes = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.nodes ?? '[]'`
      )
    ) as Array<{ id: number; x: number; y: number }>;
    expect(nodes).toHaveLength(4);

    const screenNodes = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.screenNodes ?? '[]'`
      )
    ) as Array<{ id: number; name: string }>;

    /*
      边的方向：夹具是 a → b → c，没有任何互引。
      方向在存储层算（`index-store.test.ts` 的「边的方向」逐条验过），这里只确认它
      **走到了画布这一层** —— 丢了的话箭头画不出来，而画布上的东西从外面看不见。
    */
    const edges = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.edges ?? '[]'`
      )
    ) as Array<{ source: number; target: number; mutual: boolean }>;
    const idOf = (name: string) => screenNodes.find((item) => item.name === name)!.id;
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: idOf('a.md'), target: idOf('b.md'), mutual: false },
        { source: idOf('b.md'), target: idOf('c.md'), mutual: false }
      ])
    );
    expect(edges).toHaveLength(2);

    /*
      标签在**绘制时**才算出来（要量文字宽度），所以等一拍再读。
      这一块验的是「接进 App 之后标签真的算出来了」，避让算法本身在
      `renderer/test/graph-labels.test.ts` 里逐条验过 —— 两边分工不要重复。
    */
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.labels !== '[]'`,
      20000
    );

    const labels = JSON.parse(
      await app.evaluate<string>(
        `document.querySelector('.nexus-graph-hitmap')?.dataset.labels ?? '[]'`
      )
    ) as Array<{
      id: number;
      text: string;
      rect: { left: number; top: number; right: number; bottom: number };
    }>;

    expect(labels.length).toBeGreaterThan(0);
    // 标签属于图上的文档，且**不是**所有文档都画得下 —— 密处会放弃一部分，
    // 所以这里只断言「有」与「不越界、不重叠」，不断言条数。
    expect(labels.every((label) => nodes.some((node) => node.id === label.id))).toBe(true);

    const box = await app.evaluate<{ width: number; height: number; rectHeight: number }>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const body = document.querySelector('.nexus-graph-body');
      return {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        rectHeight: body.getBoundingClientRect().height
      };
    })()`);

    // 量尺寸的目标必须是**画布自己**，不是整个面板 —— 差一个头部的高度会让位图被压扁
    expect(Math.abs(box.rectHeight - box.height)).toBeLessThan(2);

    for (const label of labels) {
      expect(label.rect.left).toBeGreaterThanOrEqual(0);
      expect(label.rect.top).toBeGreaterThanOrEqual(0);
      expect(label.rect.right).toBeLessThanOrEqual(box.width);
      expect(label.rect.bottom).toBeLessThanOrEqual(box.height);
    }

    // 任意两个标签矩形不相交
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i]!.rect;
        const b = labels[j]!.rect;
        expect(
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
          `标签「${labels[i]!.text}」与「${labels[j]!.text}」重叠了`
        ).toBe(false);
      }
    }

    // 画布上确实画了东西（不是一张空白）
    const painted = await app.evaluate<number>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const context = canvas.getContext('2d');
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) count += 1;
      }
      return count;
    })()`);
    expect(painted).toBeGreaterThan(0);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('悬停高亮该节点的一度邻域', async () => {
    const nodes = await readScreenNodes();
    const hover = (node: ScreenNode) =>
      app.evaluate(`(() => {
        const canvas = document.querySelector('.nexus-graph-canvas');
        const point = ${canvasPoint(node)};
        canvas.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: point.x, clientY: point.y
        }));
      })()`);

    // a → b：悬停 a 应该只亮 b（c 与 lonely 都不在一度邻域里）
    const a = byName(nodes, 'a.md');
    await hover(a);
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.hover).id === ${a.id}`,
      5000
    );

    const onA = await readHover();
    expect(onA.neighbors).toEqual([byName(nodes, 'b.md').id]);

    // 孤立节点没有邻域 —— 只断言「有邻域」对「把不相连的也算进来」同样成立
    const lonely = byName(nodes, 'lonely.md');
    await hover(lonely);
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.hover).id === ${lonely.id}`,
      5000
    );
    expect((await readHover()).neighbors).toEqual([]);

    /*
      鼠标离开画布后不再悬停。

      **必须派发 `mouseout`，不能派发 `mouseleave`**：React 的 `onMouseLeave` 是从
      `mouseout` 合成的（原生 `mouseenter` / `mouseleave` 不冒泡，React 收不到），
      派发 `mouseleave` 什么都不会发生 —— 而失败信息只显示「等超时」，看不出是这个原因。
      `relatedTarget` 指向画布外的元素，React 才判定为「离开」。
    */
    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      canvas.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, relatedTarget: document.body
      }));
    })()`);
    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.hover).id === null`,
      5000
    );
  }, INDEXED_TEST_TIMEOUT_MS);

  it('滚轮缩放：锚点不动、侧栏不跟着滚、缩放后仍点得中', async () => {
    /*
      「缩放后仍点得中」是投影写反时**唯一**会露馅的地方：画面看起来完全正常，
      只是点不中。所以断言必须走「读投影坐标 → 在那个位置点 → 打开的是对的文档」整条链，
      用布局坐标去点是不成立的（缩放后它本来就不对）。
    */
    expect((await readView()).scale).toBe(1);

    // 以画布中心为锚点放大
    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -700,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
    })()`);

    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.view).scale > 1.5`,
      5000
    );
    expect((await readView()).scale).toBeGreaterThan(1.5);

    // 滚轮不该把侧栏一起滚掉 —— 这条守的是「原生非 passive 监听」那个实现选择
    const sidebarScrolled = await app.evaluate<number>(
      `document.querySelector('.nexus-workspace-sidebar')?.scrollTop ?? 0`
    );
    expect(sidebarScrolled).toBe(0);

    // 双击空白取景，把被推出视口的节点带回来
    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, button: 0, clientX: rect.left + 2, clientY: rect.top + 2
      }));
    })()`);

    const box = await app.evaluate<{ width: number; height: number }>(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      return { width: canvas.clientWidth, height: canvas.clientHeight };
    })()`);

    // 取景后所有节点都该落在画布内
    await app.waitForFunction(
      `(() => {
        const nodes = JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.screenNodes);
        return nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x <= ${box.width} && n.y <= ${box.height});
      })()`,
      5000
    );

    const fitted = await readScreenNodes();
    await clickAt(canvasPoint(byName(fitted, 'a.md')));

    await app.waitForSelector('.cm-content', 20000);
    const fileName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(fileName).toBe('a.md');

    /*
      打开的那篇要在图上被标成活动节点。

      这条守的是一个从图谱落地起就存在的 bug：判据拿节点的**相对路径**去比 App 传下来的
      **绝对路径**，永远不相等。这里用的是主进程给的真实绝对路径，所以能抓到它。
    */
    const activeId = await app.evaluate<string>(
      `document.querySelector('.nexus-graph-hitmap')?.dataset.activeNode ?? ''`
    );
    expect(activeId).not.toBe('');
    expect(activeId).toBe(String(byName(fitted, 'a.md').id));
  }, INDEXED_TEST_TIMEOUT_MS);

  it('切到「当前文档」后只剩中心与两跳之内', async () => {
    /*
      接线验收：控制条 → 查询参数 → 主进程裁剪 → 面板重画。
      裁剪算法本身在 `apps/desktop/test/index-store.test.ts` 的「图谱的范围与筛选」里逐条验过，
      这里只证明**这条线接上了** —— 上一批用例结束时活动文档是 a.md（第 3 个用例打开的）。
    */
    const active = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(active).toBe('a.md');

    await app.click('.nexus-graph-chip[data-scope="current"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph .nexus-sidebar-count')?.textContent === '3'`,
      10000
    );

    // a → b → c：从 a 走两跳够到 c，lonely 够不到
    const names = (await readScreenNodes()).map((node) => node.name).sort();
    expect(names).toEqual(['a.md', 'b.md', 'c.md']);

    await app.click('.nexus-graph-chip[data-scope="all"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph .nexus-sidebar-count')?.textContent === '4'`,
      10000
    );
  }, INDEXED_TEST_TIMEOUT_MS);

  it('拖动节点不会顺手把文档打开', async () => {
    // 少了「移动超过容差就不算点击」这条，拖完一个节点会把用户从图谱里踢进编辑器
    const nodes = await readScreenNodes();
    const target = byName(nodes, 'c.md');
    const viewBefore = await readView();

    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const point = ${canvasPoint(target)};
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: point.x, clientY: point.y
      }));
      for (let step = 1; step <= 4; step += 1) {
        canvas.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: point.x + step * 8, clientY: point.y + step * 5
        }));
      }
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: point.x + 32, clientY: point.y + 20
      }));
    })()`);

    // 拖拽不该打开文档 —— 上一个用例打开的是 a.md，这里必须还是它
    const fileName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(fileName).toBe('a.md');

    // 拖的是**节点**，画布不该跟着平移
    expect(await readView()).toEqual(viewBefore);

    // 而且被拖的那个点确实动了（否则「拖了没反应」也会让上面那条通过）
    await app.waitForFunction(
      `(() => {
        const nodes = JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.screenNodes);
        const node = nodes.find((n) => n.name === 'c.md');
        return node && Math.hypot(node.x - ${target.x}, node.y - ${target.y}) > 10;
      })()`,
      5000
    );
  }, INDEXED_TEST_TIMEOUT_MS);

  it('切到孤儿 / 枢纽清单，画布真的让位', async () => {
    /*
      夹具的度数（a → b → c，外加一篇孤立的）：
                   out  in
        a.md          1   0
        b.md          1   1
        c.md          0   1
        lonely.md     0   0
    */
    const listItems = () =>
      app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-graph-list .nexus-backlink-item')).map((el) => el.textContent)`
      );

    /** 画布那一层的实际高度。`hidden` 属性必须真的把它收掉 —— 只断言属性会漏掉 CSS 优先级问题。 */
    const bodyHeight = () =>
      app.evaluate<number>(
        `document.querySelector('.nexus-graph-body').getBoundingClientRect().height`
      );

    expect(await bodyHeight()).toBeGreaterThan(0);

    await app.click('.nexus-graph-chip[data-mode="orphans"]');
    await app.waitForSelector('.nexus-graph-list', 10000);
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-body').getBoundingClientRect().height === 0`,
      10000
    );

    // 默认是「两者都缺」—— 只有 lonely
    expect(await listItems()).toEqual(['lonely.md']);

    // 切到「没人引用」：a 与 lonely
    await app.click('.nexus-graph-chip[data-orphan-mode="incoming"]');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-graph-list .nexus-backlink-item').length === 2`,
      10000
    );
    expect((await listItems()).sort()).toEqual(['a.md', 'lonely.md']);

    // 切到枢纽：b 与 c 各被引用一次，同分按路径排
    await app.click('.nexus-graph-chip[data-mode="hubs"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-list')?.textContent?.includes('b.md')`,
      10000
    );
    expect(await listItems()).toEqual(['b.md1 incoming', 'c.md1 incoming']);

    // 切回图谱视图，画布回来
    await app.click('.nexus-graph-chip[data-mode="explore"]');
    await app.waitForFunction(
      `document.querySelector('.nexus-graph-body').getBoundingClientRect().height > 0`,
      10000
    );
  }, INDEXED_TEST_TIMEOUT_MS);

  it('拖空白处平移画布，缩放不变', async () => {
    const viewBefore = await readView();

    // 从画布左下角往右下拖 —— 那里没有节点
    await app.evaluate(`(() => {
      const canvas = document.querySelector('.nexus-graph-canvas');
      const rect = canvas.getBoundingClientRect();
      const startX = rect.left + 2;
      const startY = rect.top + rect.height - 2;
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: startX, clientY: startY
      }));
      for (let step = 1; step <= 3; step += 1) {
        canvas.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: startX + step * 10, clientY: startY - step * 6
        }));
      }
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 0, clientX: startX + 30, clientY: startY - 18
      }));
    })()`);

    await app.waitForFunction(
      `JSON.parse(document.querySelector('.nexus-graph-hitmap').dataset.view).offsetX !== ${viewBefore.offsetX}`,
      5000
    );

    const viewAfter = await readView();
    expect(viewAfter.scale).toBe(viewBefore.scale);
    expect(viewAfter.offsetX).toBeCloseTo(viewBefore.offsetX + 30, 0);
    expect(viewAfter.offsetY).toBeCloseTo(viewBefore.offsetY - 18, 0);
  }, INDEXED_TEST_TIMEOUT_MS);
});
