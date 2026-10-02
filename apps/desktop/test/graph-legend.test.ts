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
 * 「谁拿哪个颜色」是纯函数，在 `renderer/test/graph-clusters.test.ts` 里验过。
 * 这里验的是它**接上真实主题之后**的结果：色块拿到的不是空串，而且不同分区真的是不同颜色。
 * 后者只有加载了主题才验得了 —— happy-dom 不解析自定义属性的继承。
 */
describe('图谱分区图例', () => {
  let tempDir: string;
  let workspace: string;
  let app: ElectronAppInstance;

  beforeAll(async () => {
    tempDir = createTempDir('nexus-graph-legend-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'archive'), { recursive: true });

    // notes 2 篇、archive 1 篇、根目录 1 篇
    fs.writeFileSync(path.join(workspace, 'notes', 'a.md'), '# A\n\n[[b]]\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'notes', 'b.md'), '# B\n\n[[c]]\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'archive', 'c.md'), '# C\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, 'root.md'), '# 根\n\n[[a]]\n', 'utf-8');

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

  it('按分区大小列出目录名与篇数，根目录下的文档并入「其他」', async () => {
    await app.waitForSelector('.nexus-graph-legend-row', 20000);

    const legend = await readLegend();
    // notes 2 篇 > archive 1 篇；根目录那篇没有分区，归到「其他」
    expect(legend.map((row) => row.cluster)).toEqual(['notes', 'archive', 'Other']);
    expect(legend.map((row) => row.count)).toEqual(['2', '1', '1']);
  }, INDEXED_TEST_TIMEOUT_MS);

  it('色块拿到的是真实主题色，且不同分区颜色不同', async () => {
    const legend = await readLegend();

    // 空串意味着 CSS 变量没解析出来 —— 那种情况下图例是一排透明方块，比没有图例更糟
    for (const row of legend) {
      expect(row.color, `分区 ${row.cluster} 的色块没有颜色`).not.toBe('');
      expect(row.color).not.toBe('rgba(0, 0, 0, 0)');
    }

    // 两个分区共用同一个色块的话，图例就是在说谎
    expect(legend[0]!.color).not.toBe(legend[1]!.color);
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
