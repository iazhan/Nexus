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
 * 填充行：目标标题**前后各铺一屏以上**。
 *
 * 前面那些负责把「## 子标题」顶出视口 —— 否则「跳转前它不在视口里」这个前置断言不成立。
 * 后面那些负责让滚动**不被钳制**：目标离文末不足一屏时，滚动到最大值就停了、行盒落在
 * 视口下方，此时「贴顶」无从谈起（`alignLineBoxToTop` 里那条判据会直接放弃补正）。
 */
const FILLER_BEFORE = Array.from({ length: 60 }, (_, index) => `前置填充 ${index + 1}`).join('\n\n');
const FILLER_AFTER = Array.from({ length: 60 }, (_, index) => `后置填充 ${index + 1}`).join('\n\n');

const DOC = [
  '# 根文档',
  '',
  '正文段落。',
  '',
  FILLER_BEFORE,
  '',
  '## 子标题',
  '',
  '更多正文。',
  '',
  FILLER_AFTER,
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
 * 目标行顶边与滚动容器顶边的距离（px）。负值表示已被顶出视口上沿。
 *
 * 用 `scrollDOM` 而不是 `view.dom`：前者才是真正的滚动容器，也是 `alignLineBoxToTop`
 * 补正时的基准。
 */
const targetTopGap = (app: ElectronAppInstance, offset: number) =>
  app.evaluate<number | null>(`(() => {
    const view = window.nexusActiveView;
    if (!view) return null;
    const coords = view.coordsAtPos(${offset});
    if (!coords) return null;
    return coords.top - view.scrollDOM.getBoundingClientRect().top;
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

    // 层级用 class 表达 —— 挂在**行容器**上而不是标题按钮上：
    // 缩进要连折叠三角一起往右移，否则三角会留在最左边、和它所属的标题对不上。
    const levels = await app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.nexus-outline-row')).map((el) =>
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

    // 而「在视口内」仍然不够 —— 只滚到「刚好可见」也满足它，用户看到的是标题贴在
    // 视口**底边**。所以再断言落点必须落在**第一行**：距滚动容器顶边不足一个行高。
    //
    // 上限取常量而不取 `view.defaultLineHeight`：后者一旦不可用就是 TypeError，
    // waitForFunction 会一路 false 到超时，伪装成「跳转没生效」。40px 比行盒宽裕、
    // 又远小于「贴底边」时那几百 px，区分度足够。
    await app.waitForFunction(
      `(() => {
        const view = window.nexusActiveView;
        const coords = view.coordsAtPos(${targetOffset});
        if (!coords) return false;
        const gap = coords.top - view.scrollDOM.getBoundingClientRect().top;
        return gap >= 0 && gap < 40;
      })()`,
      5000
    );
    const topGap = await targetTopGap(app, targetOffset);
    expect(topGap).not.toBeNull();
    expect(topGap).toBeGreaterThanOrEqual(0);
    expect(topGap).toBeLessThan(40);

    // 光标现在停在「子标题」上，所以它必须是**当前项**。
    // 这一条同时证明了「光标 → 大纲高亮」这条链真的通了：跳转把光标送过去、
    // session 把 selection 同步回 App、App 再把偏移喂给大纲。
    const activeTitle = () =>
      app.evaluate<string | null>(
        `document.querySelector('.nexus-outline-item[data-active="true"]')?.textContent ?? null`
      );

    await app.waitForFunction(
      `document.querySelector('.nexus-outline-item[data-active="true"]')?.textContent === '子标题'`,
      5000
    );
    expect(await activeTitle()).toBe('子标题');

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

    // 折叠：此时大纲是 [新标题(h3), 根文档(h1), 子标题(h2)]。
    // 只有「根文档」有可折叠的子孙 —— 「新标题」后面跟的是 h1，层级不更深。
    const outlineTitles = () =>
      app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-outline-item')).map((el) => el.textContent)`
      );
    const clickOutlineToggle = () =>
      app.evaluate(`(() => {
        document.querySelectorAll('button.nexus-outline-toggle')[0].click();
        return true;
      })()`);

    expect(await outlineTitles()).toEqual(['新标题', '根文档', '子标题']);

    await clickOutlineToggle();
    await app.waitForFunction(`document.querySelectorAll('.nexus-outline-item').length === 2`, 5000);
    expect(await outlineTitles()).toEqual(['新标题', '根文档']);
    // 当前项（子标题）被折进了「根文档」里，列表里没有它 —— 于是没有高亮项。
    // 这是**有意**的：用户自己折的，不会希望它被偷偷展开。
    expect(await activeTitle()).toBeNull();

    await clickOutlineToggle();
    await app.waitForFunction(`document.querySelectorAll('.nexus-outline-item').length === 3`, 5000);
    expect(await outlineTitles()).toEqual(['新标题', '根文档', '子标题']);
    expect(await activeTitle()).toBe('子标题');

    // 大纲比面板高时，当前项要跟着滚进**面板自己的**视口。
    // 先塞够标题把面板撑出滚动条 —— 默认窗口 800×600，侧栏面板放不下 40 多行。
    await app.evaluate(`(() => {
      const session = window.nexusSession;
      const end = session.getSnapshot().source.length;
      const extra = Array.from({ length: 40 }, (_, index) => '## 章节 ' + (index + 1)).join('\\n');
      session.dispatch({ changes: [{ from: end, to: end, insert: '\\n' + extra + '\\n' }] });
      return true;
    })()`);
    await app.waitForFunction(
      `document.querySelectorAll('.nexus-outline-item').length === 43`,
      5000
    );

    // 点最后一项：光标被送过去、编辑器视口跟着走，大纲面板里那一项也必须露出来
    await app.evaluate(`(() => {
      const items = document.querySelectorAll('.nexus-outline-item');
      items[items.length - 1].click();
      return true;
    })()`);
    await app.waitForFunction(
      `document.querySelector('.nexus-outline-item[data-active="true"]')?.textContent === '章节 40'`,
      5000
    );
    await app.waitForFunction(
      `document.querySelector('.nexus-sidebar-list').scrollTop > 0`,
      5000
    );
    expect(
      await app.evaluate<number>(`document.querySelector('.nexus-sidebar-list').scrollTop`)
    ).toBeGreaterThan(0);
  }, INDEXED_TEST_TIMEOUT_MS);
});
