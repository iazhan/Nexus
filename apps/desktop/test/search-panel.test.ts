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
    tempDir = createTempDir('nexus-search-');
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
    // 与 ethercat.md 共用「分布式时钟」一词，让多文件命中那条能拉开条目分隔；
    // 命中词离段首超过一个窗口（48 字），所以片段必须是**截出来的**而不是整段。
    fs.writeFileSync(
      path.join(workspace, 'notes', 'clock.md'),
      '# 时钟\n\n开头一句独特的话，然后是说寄存器映射与 PDO 分配，看门狗与状态机，'
        + '电源接线与拓扑结构，错误码与诊断，最后才讲到分布式时钟的抖动要控制在一微秒以内，'
        + '各节点才对得齐，收尾一句。\n',
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
    await app.waitForIndexReady();

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
  }, INDEXED_TEST_TIMEOUT_MS);

  /**
   * 命中条目的**上下文片段**。
   *
   * 片段由主进程从原文表里现摘（FTS 里存的是按字切过的正文，不能直接拿来当片段），
   * 所以这条真机用例守的是「主进程摘的片段 → 渲染层切三段」整条链。两件容易悄悄坏掉的：
   * - 片段必须是**截出来的窗口**（命中词前后各 48 字），不是整段 —— 否则长文档一屏都放不下；
   * - 高亮位置来自主进程给的 `from` / `to`，模板改过一次字符就会整体错位。
   */
  it('多文件命中带上下文片段，命中词高亮且位置不偏', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    await app.waitForIndexReady();
    await app.click('.nexus-activity-icon[data-activity="search"]');
    await app.waitForSelector('.nexus-search-input', 10000);

    await typeQuery(app, '分布式时钟');
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-search-hit').length === 2`,
      10000
    );

    // 每个条目都该有一段上下文
    const snippets = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-search-hit-snippet')).map((el) => el.textContent ?? '')`
    );
    expect(snippets.length).toBe(2);
    for (const snippet of snippets) {
      expect(snippet).toContain('分布式时钟');
    }

    // clock.md 的命中词离段首 57 字，超过一个窗口：片段必须是截出来的，
    // 段首那句不在里面
    const clockSnippet = await app.evaluate<string | null>(
      `(() => {
        const hit = Array.from(document.querySelectorAll('.nexus-search-hit'))
          .find((el) => (el.querySelector('.nexus-search-hit-name')?.textContent ?? '') === 'clock.md');
        return hit?.querySelector('.nexus-search-hit-snippet')?.textContent ?? null;
      })()`
    );
    expect(clockSnippet).not.toBeNull();
    expect(clockSnippet).toContain('分布式时钟');
    expect(clockSnippet).not.toContain('开头一句独特的话');

    // 高亮只圈命中词本身：mark 里的字正好等于查询词，且它在片段里只出现一次
    const marks = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-search-hit-mark')).map((el) => el.textContent ?? '')`
    );
    expect(marks.length).toBe(2);
    expect(marks.every((text) => text === '分布式时钟')).toBe(true);
    expect(clockSnippet?.split('分布式时钟').length).toBe(2);

    // 条目之间有分隔线（多文件命中时靠它分清谁是谁）
    expect(
      await app.evaluate<number>(
        `getComputedStyle(document.querySelector('.nexus-search-results > li + li')).borderTopWidth !== '0px' ? 1 : 0`
      )
    ).toBe(1);
  }, INDEXED_TEST_TIMEOUT_MS);
});
