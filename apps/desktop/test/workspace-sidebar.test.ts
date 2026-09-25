// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 工作区侧栏（P2-06 第一步）。
 *
 * 在这之前 workspace 模式只有一个空态占位 —— 用户能打开工作区，却没法从里面
 * 打开任何文件。这条用例验证整条链路：
 *   启动工作区 → 建索引 → 侧栏列出文档 → 点击 → 打开成标签页 → 内容正确。
 */
describe('工作区侧栏', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sidebar-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'root.md'),
      '# 根文档\n\n记录 EtherCAT 从站的 PDO 映射。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输，注意缓存一致性。\n',
      'utf-8'
    );
    // 非 Markdown 不该出现在列表里
    fs.writeFileSync(path.join(workspace, 'notes', 'ignore.txt'), '不是 markdown', 'utf-8');
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

  it('列出工作区文档，点击后打开为标签页并显示正确内容', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-workspace-sidebar', 20000);

    // 面板默认就是展开的（初始状态自洽），这里不需要先点图标

    // 等索引跑完、文件树渲染出来
    // 先等侧栏容器（它立即出现），再等文件树。
    // 分开等 + 超时 dump 内容，是为了区分「侧栏没挂载」和「索引没跑完/失败了」——
    // 只等 .nexus-tree-item 的话这两种情况看起来一模一样。
    await app.waitForSelector('.nexus-workspace-sidebar', 30000);
    try {
      await app.waitForSelector('.nexus-tree-item', 120000);
    } catch (err) {
      const dump = await app.evaluate<string>(
        `document.querySelector('.nexus-workspace-sidebar')?.textContent ?? '(侧栏不存在)'`
      );
      throw new Error(
        `等待文件树超时。侧栏当前内容: ${dump} / 原始错误: ${err instanceof Error ? err.message : err}`
      );
    }

    const items = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-tree-name')).map((el) => el.textContent)`
    );
    // 顶层目录默认展开，所以 notes 和它里面的 dma.md 都在；目录排在文件前面，且不含 .txt
    expect(items).toEqual(['notes', 'dma.md', 'root.md']);

    // 还没打开任何文件：不应有编辑器
    expect(await app.evaluate<number>(`document.querySelectorAll('.cm-content').length`)).toBe(0);

    // 点第一个**文件**（dma.md）—— 点目录只会展开/收起
    await app.click('.nexus-tree-file');
    await app.waitForSelector('.cm-content', 20000);

    const headerName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(headerName).toBe('dma.md');

    const source = await app.evaluate<string>(`window.nexusSession.getSnapshot().source`);
    expect(source).toContain('缓存一致性');

    // 侧栏在文档打开后仍在，且当前项被标记为活动
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-tree-item-active').length`)
    ).toBe(1);
  }, 180000);
});
