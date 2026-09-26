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

/** 填充行：把「## 子标题」推到视口外，这样才验得出「跳转时视口有没有跟着动」。 */
const FILLER = Array.from({ length: 120 }, (_, index) => `填充行 ${index + 1}`).join('\n\n');

const DOC = [
  '# 根文档',
  '',
  '正文段落。',
  '',
  FILLER,
  '',
  '## 子标题',
  '',
  '更多正文。',
  ''
].join('\n');

/** 目标偏移是否落在编辑器视口内。 */
const targetInViewport = (app: ElectronAppInstance, offset: number) =>
  app.evaluate<boolean>(`(() => {
    const view = window.nexusActiveView;
    if (!view) return false;
    const coords = view.coordsAtPos(${offset});
    if (!coords) return false;
    const rect = view.dom.getBoundingClientRect();
    return coords.top >= rect.top && coords.bottom <= rect.bottom;
  })()`);

/**
 * 大纲面板。
 *
 * 数据来自**当前编辑器源码**（不是索引），所以它要跟随编辑实时更新。
 * 这里验证：列出标题 → 点击跳转 → 编辑后列表跟着变。
 */
describe('大纲面板', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-outline-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'doc.md'), DOC, 'utf-8');
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

  // 超时放宽：这个用例跑完整链路（启动工作区 → 索引 → 打开文件 → 切面板 → 跳转 → 编辑），
  // 全量运行时机器负载高，30s 的默认上限会贴边。
  it('列出标题、点击跳转，并跟随编辑更新', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    // 打开工作区里的文档
    await app.click('.nexus-activity-icon[data-activity="workspace"]');
    // 120s：这一步要等侧栏跑完**整个工作区的索引**再渲染出文件树。
    // 空载约 20s，但全量串行跑到后半段时机器已被前面的 Electron 实例拖慢，
    // 实测 60s 也会超。waitForSelector 用的是自己的超时，不受 vitest testTimeout 影响。
    await app.waitForIndexReady();
    await app.click('.nexus-tree-file');
    await app.waitForSelector('.cm-content', 20000);

    // 切到大纲面板
    await app.click('.nexus-activity-icon[data-activity="outline"]');
    await app.waitForSelector('.nexus-outline-item', 10000);

    const items = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-outline-item')).map((el) => el.textContent)`
    );
    expect(items).toEqual(['根文档', '子标题']);

    // 层级用 class 表达
    const levels = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-outline-item')).map((el) =>
         el.className.includes('nexus-outline-level-2') ? '2' : '1')`
    );
    expect(levels).toEqual(['1', '2']);

    // 点第二个标题 → 光标跳到它的源码偏移，且**视口要跟着滚过去**
    const targetOffset = DOC.indexOf('## 子标题');

    // 跳转前：120 行填充把目标顶到视口外
    expect(await targetInViewport(app, targetOffset)).toBe(false);

    await app.evaluate(`document.querySelectorAll('.nexus-outline-item')[1].click(), true`);
    await app.waitForFunction(
      `window.nexusSession.getSnapshot().selection.anchor === ${targetOffset}`,
      5000
    );

    // **这条才是关键**：只断言 session 的 selection 是不够的 ——
    // 早先 handleOutlineJump 只改 session（session → view 的同步不带 scrollIntoView），
    // selection 变了、视口却纹丝不动，那个 bug 正是被「只断言 session」放过的。
    await app.waitForFunction(
      `(() => {
        const view = window.nexusActiveView;
        const coords = view.coordsAtPos(${targetOffset});
        if (!coords) return false;
        const rect = view.dom.getBoundingClientRect();
        return coords.top >= rect.top && coords.bottom <= rect.bottom;
      })()`,
      5000
    );
    expect(await targetInViewport(app, targetOffset)).toBe(true);

    // 跳转不该产生可撤销的编辑历史：source 必须原封不动
    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toBe(DOC);

    // 在文档开头插入一个新标题，大纲要跟着变
    await app.evaluate(`(() => {
      window.nexusSession.dispatch({ changes: [{ from: 0, to: 0, insert: '### 新标题\\n\\n' }] });
      return true;
    })()`);
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-outline-item').length === 3`,
      5000
    );
    expect(await app.evaluate<string>(
      `document.querySelector('.nexus-outline-item')?.textContent ?? ''`
    )).toBe('新标题');
  }, INDEXED_TEST_TIMEOUT_MS);
});
