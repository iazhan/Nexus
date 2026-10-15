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
 * 图谱的**分区图例**。
 *
 * 单独一个文件、单独一次启动：图例要有分区才画得出来，而这组夹具必须是**带子目录**的
 * 工作区。塞进 `graph-panel.test.ts` 会改掉那边每个用例依赖的节点数与孤儿名单。
 *
 * 「谁拿哪个颜色」是纯函数，在 `renderer/test/graph-clusters.test.ts` 里验过；
 * 「八色真的分得开」在 `packages/theme/test/derive.test.ts` 里按 OKLab 距离验过。
 * 这里验的是它**接上真实主题之后**的结果：色块拿到的不是空串，不同分区真的是不同颜色。
 * 后者只有加载了主题才验得了 —— happy-dom 不解析自定义属性的继承。
 *
 * ## 夹具是 **9 个顶层目录**，不是 3 个
 *
 * 调色板是 8 色，而这一屏最容易出错的两处都在边界上：
 *
 * - 第 8 个分区仍然拿得到专属色（不是提前并进「其他」）；
 * - 第 9 个分区**并入**「其他」，**不复用**前面任何一个槽位（复用会让图例出现两个同样的
 *   色块，而它们属于不同的目录 —— 那正是图例说谎的样子）。
 *
 * 三个目录的夹具两种错法都测不出来。
 */
describe('图谱分区图例', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  /** 顶层目录名与其中的文档数。d1 最多、d2 次之，d3..d9 同数（按名字排）。 */
  const CLUSTERS: ReadonlyArray<readonly [string, number]> = [
    ['d1', 3],
    ['d2', 2],
    ['d3', 1],
    ['d4', 1],
    ['d5', 1],
    ['d6', 1],
    ['d7', 1],
    ['d8', 1],
    ['d9', 1]
  ];

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-legend-');
    workspace = path.join(tempDir, 'vault');

    for (const [name, count] of CLUSTERS) {
      const dir = path.join(workspace, name);
      fs.mkdirSync(dir, { recursive: true });
      for (let index = 0; index < count; index += 1) {
        // 每个目录内部连成链，保证图上真的有边（不然这一屏只有孤立点）
        const next = index + 1 < count ? `\n\n[[${name}-${index + 1}]]\n` : '\n';
        fs.writeFileSync(path.join(dir, `${name}-${index}.md`), `# ${name}-${index}${next}`, 'utf-8');
      }
    }
    // 根目录下的一篇：没有分区，和 d9 一起并进「其他」
    fs.writeFileSync(path.join(workspace, 'root.md'), '# 根\n\n[[d1-0]]\n', 'utf-8');

    app = await launchElectronApp({ filePath: workspace });
    await app.waitForIndexReady();
    await app.click('.nexus-activity-icon[data-activity="graph"]');
    await app.waitForSelector('.nexus-graph-canvas', 20000);
  }, INDEXED_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const readLegend = () =>
    app.evaluate<Array<{ cluster: string; count: string; color: string }>>(`(() => {
      return Array.from(document.querySelectorAll('.nexus-graph-legend-row')).map((row) => {
        const swatch = row.querySelector('.nexus-graph-legend-swatch');
        return {
          cluster: row.getAttribute('data-cluster'),
          count: row.querySelector('.nexus-graph-legend-count')?.textContent ?? '',
          color: swatch ? getComputedStyle(swatch).backgroundColor : ''
        };
      });
    })()`);

  it('按分区大小列出目录名与篇数，第 9 个分区与根目录文档并入「其他」', async () => {
    await app.waitForSelector('.nexus-graph-legend-row', 20000);

    const legend = await readLegend();
    // d1 3 篇 > d2 2 篇 > d3..d9 各 1 篇（同数按名字）；d9 排在第 9 位，掉出调色板
    expect(legend.map((row) => row.cluster)).toEqual([
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
      'd8',
      'Other'
    ]);
    // 「其他」= d9 那 1 篇 + 根目录那 1 篇
    expect(legend.map((row) => row.count)).toEqual(['3', '2', '1', '1', '1', '1', '1', '1', '2']);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('图例有可见标题 —— 不是只有 `aria-label`', async () => {
    /*
      「用户看不看得见」这件事只有真机算数：渲染层那条用例读的是同一份 DOM，
      但它不跑 CSS，验不了「标题真的排在图例里、没有被挤成 0 宽」。
    */
    const title = await app.evaluate<{ text: string; width: number }>(`(() => {
      const node = document.querySelector('.nexus-graph-legend-title');
      if (!node) return { text: '', width: 0 };
      return { text: node.textContent ?? '', width: Math.round(node.getBoundingClientRect().width) };
    })()`);

    expect(title.text).toBe('Folders');
    // 有文字还不够 —— 宽度为 0 说明它被挤没了，屏幕上仍然什么都看不到
    expect(title.width).toBeGreaterThan(0);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('八个分区拿到八个互不相同的主题色，且都不等于「其他」的中性色', async () => {
    const legend = await readLegend();
    const clusters = legend.filter((row) => row.cluster !== 'Other');
    const other = legend.find((row) => row.cluster === 'Other')!;

    // 空串意味着 CSS 变量没解析出来 —— 那种情况下图例是一排透明方块，比没有图例更糟
    for (const row of legend) {
      expect(row.color, `分区 ${row.cluster} 的色块没有颜色`).not.toBe('');
      expect(row.color).not.toBe('rgba(0, 0, 0, 0)');
    }

    expect(clusters).toHaveLength(8);
    // 两个分区共用同一个色块的话，图例就是在说谎
    expect(new Set(clusters.map((row) => row.color)).size).toBe(8);
    // 「其他」是中性色，不能混进调色板 —— 混进去等于多出一个分区
    expect(clusters.map((row) => row.color)).not.toContain(other.color);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('图例不吃点击 —— 它盖住的点仍然点得中', async () => {
    /*
      图例压在画布左下角。`pointer-events` 没关掉的话，它盖住的那块区域变成「点了没反应」，
      而用户完全看不出是图例挡的。这里验的是它确实不接收指针事件。
    */
    const interactive = await app.evaluate<string>(`(() => {
      const legend = document.querySelector('.nexus-graph-legend');
      return getComputedStyle(legend).pointerEvents;
    })()`);
    expect(interactive).toBe('none');
  }, INDEXED_TEST_TIMEOUT_MS);
});
