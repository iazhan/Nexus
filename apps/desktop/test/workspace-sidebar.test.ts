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
    tempDir = createTempDir('nexus-sidebar-');
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

    // 面板默认就是展开的（初始状态自洽），这里不需要先点图标

    // 等索引跑完、文件树渲染出来。
    // 「先等容器再等树」和失败时的诊断都在 waitForIndexReady 里，这里不用重复。
    await app.waitForIndexReady();

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

    // ---- 工具栏：新建 → 出现在树里 → 开成标签页 → 选中 → 删除 → 消失 ----
    //
    // 这一段是**整条链路的端到端证明**：树的两路数据源（索引 + 目录列举）、
    // 主进程的排他创建与单文件索引、以及「建完把选中项挪过去」全在里面。
    // 上面刚点过 `notes/dma.md`，所以选中项是它 —— 新文件应当落在 `notes/` 旁边。
    const clickToolbar = (action: string) =>
      app.evaluate<boolean>(`(() => {
        const button = document.querySelector('.nexus-toolbar-button[data-action="${action}"]');
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);

    expect(await clickToolbar('new-file')).toBe(true);
    await app.waitForSelector('.nexus-tree-new-input', 15000);

    // 受控输入框要走原生 setter，直接改 `value` 会被 React 的 value 跟踪器吞掉
    await app.evaluate(`(() => {
      const input = document.querySelector('.nexus-tree-new-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '周报');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);

    const createdPath = path.join(workspace, 'notes', '周报.md');
    await app.waitForFunction(
      `Array.from(document.querySelectorAll('.nexus-tree-name')).some((el) => el.textContent === '周报.md')`,
      20000
    );
    // 主进程补的扩展名、落点、磁盘上的字节，三样都要对
    expect(fs.readFileSync(createdPath, 'utf-8')).toBe('');
    // 建完就打开
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-filename')?.textContent ?? ''`)
    ).toBe('周报.md');
    // **选中项跟着挪到新文件上** —— 否则下一步的删除会删掉 dma.md。
    //
    // 用 `waitForFunction` 而不是直接断言：那一行出现在树里（列表重读完）与它被选中
    // 之间隔着一个 effect —— 「建完把选中挪过去」是在**下一次**提交里发生的。
    // 直接断言会变成一条看运气的用例（实测同一份代码一次过、一次不过）。
    await app.waitForFunction(
      `document.querySelectorAll('[data-relative-path="notes/周报.md"][data-selected="true"]').length === 1`,
      15000
    );

    // 删除（默认档是回收站，不弹确认框）
    expect(await clickToolbar('delete')).toBe(true);
    await app.waitForFunction(
      `!Array.from(document.querySelectorAll('.nexus-tree-name')).some((el) => el.textContent === '周报.md')`,
      20000
    );
    expect(fs.existsSync(createdPath)).toBe(false);

    // ---- 刷新：在盘上直接放一个文件，点刷新之后它出现 ----
    //
    // 这一条是「刷新」这个动作存在的全部理由：树来自**索引**，而索引只在「重建」时
    // 更新 —— 在资源管理器里加的文件不会自己进树。
    const externalPath = path.join(workspace, '外部新增.md');
    fs.writeFileSync(externalPath, '# 外部新增\n', 'utf-8');

    expect(await clickToolbar('refresh')).toBe(true);
    await app.waitForFunction(
      `Array.from(document.querySelectorAll('.nexus-tree-name')).some((el) => el.textContent === '外部新增.md')`,
      25000
    );
  }, INDEXED_TEST_TIMEOUT_MS);
});
