// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/** 轮询到条件成立；返回是否成立（不用断言，调用方决定怎么报）。 */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

/** 与 `HistoryStore` 同口径的内容哈希（sha256 前 8 位）—— 铺盘造数据时要造对。 */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

const SEEDED = 25;
const LIMIT = 20;

/**
 * 历史快照上限的**端到端接线**。
 *
 * 这条链路横跨三个进程边界，任何一段断了都不会报错，只会「设置页显示保留 20 份、
 * 实际一个都不删」：
 *
 *   设置窗口的下拉 → 渲染进程的存档 → 宿主设置通道 → 主进程的缓存 → `HistoryStore.record`
 *
 * 每一段单独都有用例（`renderer/test/host-settings.test.ts`、`electron/host-settings.test.ts`、
 * `history-store.test.ts`），但**它们全绿也证明不了这条链是通的** —— 各自都用了打桩的对端。
 * 这一条不打断言，直接数磁盘上的文件。
 *
 * 做法是**在磁盘上先铺好 25 份历史**再启动：连着存 25 次真实内容要等 25 次自动保存防抖，
 * 而且时间戳精度是秒，同一秒内写多条排序不确定。铺盘还顺带覆盖了「上限调小之后，
 * 已有的那一堆怎么办」这个真实场景。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回。
 */
describe('历史快照上限（端到端）', () => {
  let tempDir: string;
  let workspace: string;
  let historyDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-history-retention-');
    workspace = path.join(tempDir, 'vault');
    historyDir = path.join(workspace, '.nexus', 'history', 'note.md');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'note.md'), '# 原内容\n', 'utf8');

    fs.mkdirSync(historyDir, { recursive: true });
    for (let index = 1; index <= SEEDED; index += 1) {
      const content = `旧内容 ${index}`;
      const savedAt = `20260901T${String(index).padStart(6, '0')}`;
      fs.writeFileSync(
        path.join(historyDir, `${savedAt}-${contentHash(content)}.md`),
        content,
        'utf8'
      );
    }
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

  function historyCount(): number {
    try {
      return fs.readdirSync(historyDir).length;
    } catch {
      return 0;
    }
  }

  /** 历史目录里所有条目的内容（顺序不重要，判据是集合成员）。 */
  function historyContents(): string[] {
    return fs
      .readdirSync(historyDir)
      .map((name) => fs.readFileSync(path.join(historyDir, name), 'utf8'));
  }

  it('设置窗口改的上限，真的会传到主进程并删掉最旧的那批', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);
    await app.waitForIndexReady();
    expect(historyCount(), '铺好的 25 份应当原样在盘上').toBe(SEEDED);

    // ① 开设置窗口，把上限调到 20
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);

    await app.click('.nexus-settings-nav [data-section="data"]');
    await app.waitForSelector('[data-field-input="data.historyRetention"]', 10000);
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-field-input="data.historyRetention"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '20');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    expect(
      await app.evaluate<string>(`localStorage.getItem('nexus-history-retention') ?? ''`),
      '选中的档位应当进存档'
    ).toBe(String(LIMIT));

    // ② **改设置本身不删任何东西** —— 修剪发生在「留快照那一刻」，没有独立的清扫任务。
    //    这一条钉住的就是那个设计：换成定时清扫的实现，用户改完设置回到文档时历史已经被削过了。
    expect(historyCount(), '改设置不该立刻动历史').toBe(SEEDED);

    // ③ 回主窗口，打开 note.md 改成新内容 → 自动保存时留快照并按上限修剪
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-tree-file', 20000);
    await app.evaluate(`(() => {
      const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
      files.find((el) => el.textContent?.includes('note'))?.click();
      return true;
    })()`);
    await app.waitForSelector('.cm-content', 20000);
    await app.setSource('# 新内容\n');

    const trimmed = await waitUntil(() => historyCount() === LIMIT, 20000);
    expect(
      trimmed,
      `历史应当被削到 ${LIMIT} 份，实际 ${historyCount()} 份`
    ).toBe(true);

    // ④ 留下的必须是**最新的**那批。只数条数是不够的：删错了同样会得到 20。
    const contents = historyContents();
    // 刚写的那条快照是「保存前的旧内容」
    expect(contents, '保存前的旧内容应当留成一条快照').toContain('# 原内容\n');
    // 25 + 1 条里削掉最旧的 6 条
    expect(contents, '最旧的六份应当被删掉').not.toContain('旧内容 1');
    expect(contents).not.toContain('旧内容 6');
    expect(contents, '第 7 份正好是留下的最旧一份').toContain('旧内容 7');
    expect(contents, '最新的一份必须留着').toContain('旧内容 25');

    // ⑤ 换回「不清理」后不再删 —— 上限是**当前值**，不是一次性的。
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-field-input="data.historyRetention"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'unlimited');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.setSource('# 又一个新内容\n');
    const saved = await waitUntil(
      () => fs.readFileSync(path.join(workspace, 'note.md'), 'utf8') === '# 又一个新内容\n',
      15000
    );
    expect(saved, '自动保存应当写进磁盘').toBe(true);

    // 又多了一条快照，且一条都没删
    const afterUnlimited = await waitUntil(() => historyCount() === LIMIT + 1, 10000);
    expect(
      afterUnlimited,
      `换成不清理后应当只增不删，实际 ${historyCount()} 份`
    ).toBe(true);
  }, INDEXED_TEST_TIMEOUT_MS);
});
