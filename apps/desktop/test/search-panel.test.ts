// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 工作区搜索面板。
 *
 * 重点验证**中文 2 字词**能搜到 —— 这是 ADR-0002 里两种内置分词器都做不到、
 * 必须靠应用层按字切分才成立的事。英文检索在这里不是重点。
 */
describe('搜索面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-'));
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, 'ethercat.md'),
      '# EtherCAT\n\n记录从站的 PDO 映射与分布式时钟同步。\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(workspace, 'notes', 'dma.md'),
      '# DMA\n\n控制器支持多通道传输。\n',
      'utf-8'
    );
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

  /** React 受控输入要用原生 setter + input 事件，直接改 value 不会触发 onChange。 */
  const typeQuery = (app: ElectronAppInstance, value: string) =>
    app.evaluate(`(() => {
      const input = document.querySelector('.nexus-search-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  it('中文 2 字词能搜到，点击结果打开对应文档', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    // 先展开工作区面板 —— 它会跑一次索引，搜索依赖它
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForSelector('.nexus-tree-item', 30000);

    // 切到搜索
    await app.click('.nexus-activity-icon[data-activity="search"]');
    await app.waitForSelector('.nexus-search-input', 10000);

    // 初始是提示态，不是空列表
    expect(await app.evaluate<number>(`document.querySelectorAll('.nexus-search-hit').length`)).toBe(0);

    await typeQuery(app, '从站');
    await app.waitForSelector('.nexus-search-hit', 10000);

    const names = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-search-hit-name')).map((el) => el.textContent)`
    );
    expect(names).toEqual(['ethercat.md']);

    // 相对路径也显示出来（跨工作区搜索时用来区分重名文件）
    expect(
      await app.evaluate<string>(
        `document.querySelector('.nexus-search-hit-path')?.textContent ?? ''`
      )
    ).toBe('ethercat.md');

    // 点击结果 → 打开该文档
    await app.click('.nexus-search-hit');
    await app.waitForSelector('.cm-content', 20000);
    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toContain('从站');

    // 换一个搜不到的词 → 显示无结果，而不是留着上一次的结果
    await typeQuery(app, '完全不存在的词汇zzz');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-search-hit').length === 0`,
      10000
    );
  });
});
