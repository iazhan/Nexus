// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  launchElectronApp,
  createTempDir,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  UPDATE_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * `apps/desktop/package.json` 里的版本 —— 也就是 `app.getVersion()` 在**未打包**运行时
 * 会读到的那个。用它当期望值而不是「非空」：后者对一个写死的字符串也过。
 */
const EXPECTED_APP_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'),
      'utf-8'
    )
  ) as { version: string }
).version;

/**
 * 更新窗口的真机接线。
 *
 * 五件事只有真机能证：
 *
 * 1. **它真是第三个窗口**（不是主窗口里换了个视图、也不是设置页的一块）——
 *    设置页那一行点下去开出来的是**另一个 CDP page target**，URL 带 `window=update`。
 * 2. **单例** —— 重复点不会开出第二个更新窗口。
 * 3. **`app.getVersion()` 真的走通了** —— 窗口里显示的版本与 `package.json` 一致。
 *    这条同时证明了 preload 暴露了 `getUpdateState`、主进程那条 handler 被走到、
 *    以及渲染进程把 `current` 画了出来。
 * 4. **未打包时阶段是 `unsupported`** —— 测试进程没有 `app-update.yml`，
 *    这是「这个构建没有更新通道」在界面上的样子，而不是一个卡在「尚未检查」的假象。
 * 5. **更新日志真的拿到了** —— 三层回落里至少「内置 `changelog.json`」那层是活的
 *    （dev/测试下 `changelogDir()` 指向仓库根）。它不依赖更新通道，所以未打包也看得到。
 *    「显示全部历史版本」那个开关因此能端到端验：勾上之后 0.73.0（当前版本）那张卡片出现。
 *
 * 各层分支（阶段文案、进度条、跳过/稍后的按钮显隐、Escape 的两条路）在
 * `renderer/test/` 的组件用例里；状态机在 `updater.test.ts`；三层回落与合并规则在
 * `changelog.test.ts`。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条交互链塞进同一个用例。
 */
describe('更新窗口', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-update-window-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n正文。\n', 'utf-8');
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

  it('从设置页开窗、内容齐备、日志开关、单例、Escape 关窗', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);

    // ① 起初只有主窗口，主窗口里**没有**更新界面
    expect((await app.pageTargets()).length).toBe(1);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-update-view')`)).toBe(
      false
    );

    // ② 走真实入口：设置页「关于」分组里的那一行。
    //    `Mod-,` 用 `dispatchKey`（DOM 派发）而不是 `pressKey`：后者走 CDP 输入管线、
    //    依赖窗口真实持有系统焦点，无头运行下不可靠。
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    // 设置窗口默认落在 `appearance`（`DEFAULT_SECTION_ID`），版本那一行在「关于」组。
    await app.waitForSelector('.nexus-settings-nav [data-section="about"]', 15000);
    await app.click('.nexus-settings-nav [data-section="about"]');
    await app.waitForSelector('[data-field-action="about.version"]', 15000);
    // 未打包也**点得动** —— 这一行只负责开门，窗口自己会说明没有更新通道。
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-field-action="about.version"]').disabled`
      )
    ).toBe(false);

    await app.click('[data-field-action="about.version"]');

    // ③ 开出来的是**第三个窗口**
    await app.waitForPageCount(UPDATE_WINDOW_URL_MARKER, 1, 15000);
    expect((await app.pageTargets()).length).toBe(3);

    await app.attachToWindow(UPDATE_WINDOW_URL_MARKER);
    await app.waitForSelector('[data-window-role="update"]', 15000);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-update-view')`)).toBe(true);

    // ④ 版本行：显示的就是 `package.json` 里那个。
    //    这条要三样同时成立才过：preload 暴露了 `getUpdateState`、主进程真的从
    //    `app.getVersion()` 读到版本、渲染进程把它画了出来。
    await app.waitForSelector('[data-current-version]', 15000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-current-version]').textContent`
      )
    ).toBe(EXPECTED_APP_VERSION);

    // ⑤ 未打包 → `unsupported`，且状态行有话说（不是空白，也不是「尚未检查」那种假象）。
    expect(await app.evaluate<string>(`document.querySelector('[data-update-phase]').dataset.updatePhase`)).toBe(
      'unsupported'
    );
    expect(
      (
        await app.evaluate<string>(
          `document.querySelector('[data-update-status]').textContent`
        )
      ).trim()
    ).not.toBe('');

    // ⑥ 未打包时「检查更新」按不动 —— 点下去只会失败。这个构建根本没有那条通道。
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('.nexus-update-button-primary').disabled`
      )
    ).toBe(true);
    //    底部只有这一个按钮：没有更新可装，所以「稍后 / 跳过 / 立即重启」都不该出现。
    //    不比按钮文案 —— 那要 import `@nexus/i18n` 的 dist，真机用例一律只读 DOM。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.nexus-update-actions button').length`)
    ).toBe(1);

    // ⑦ 更新日志：三层回落里「内置 changelog.json」那层在 dev/测试下指向仓库根，
    //    所以即使没有网络、即使未打包，这一段也拿得到内容。
    //    先等它落定（远端那次拉取最长 8s 超时），否则下面数的卡片数会在拉取回来的瞬间变。
    await app.waitForSelector('[data-changelog-state="ready"]', 25000);

    //    默认只画**比当前版本新**的那些，所以当前版本 0.73.0 那张卡片一开始不在。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-release="0.73.0"]').length`)
    ).toBe(0);

    const collapsedCount = await app.evaluate<number>(
      `document.querySelectorAll('[data-release]').length`
    );

    //    勾上「显示全部历史版本」→ 当前版本那张卡片出现。
    await app.click('.nexus-update-show-all input');
    await app.waitForSelector('[data-release="0.73.0"]', 10000);
    expect(await app.evaluate<number>(`document.querySelectorAll('[data-release]').length`)).toBeGreaterThanOrEqual(
      4
    );
    //    取消勾选 → 回到默认视图。开关是活的，不是一次性渲染。
    await app.click('.nexus-update-show-all input');
    await app.waitForFunction(
      `() => document.querySelectorAll('[data-release]').length === ${collapsedCount}`,
      10000
    );

    // ⑧ 单例：回设置页再点一次，不该开出第二个更新窗口
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.click('[data-field-action="about.version"]');
    //    等一会儿再看：单例失效的话第二个窗口会在这段时间里冒出来。页面里数不到
    //    别的窗口，只能给它一个观察窗口 —— 1.5s 远大于建窗到 CDP 可见的时间。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(
      (await app.pageTargets()).filter((target) => target.url.includes(UPDATE_WINDOW_URL_MARKER)).length
    ).toBe(1);
    expect((await app.pageTargets()).length).toBe(3);

    // ⑨ 主窗口从头到尾没被挤进任何东西
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(true);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-update-view')`)).toBe(false);

    // ⑩ Escape 关掉更新窗口；设置窗口与主窗口都不受影响
    await app.attachToWindow(UPDATE_WINDOW_URL_MARKER);
    await app.dispatchKey('Escape');
    await app.waitForPageCount(UPDATE_WINDOW_URL_MARKER, 0, 10000);
    expect((await app.pageTargets()).length).toBe(2);

    // ⑪ 关掉之后能再开 —— 单例是「同一时间只有一个」，不是「一辈子只开一次」
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.click('[data-field-action="about.version"]');
    await app.waitForPageCount(UPDATE_WINDOW_URL_MARKER, 1, 15000);
    expect((await app.pageTargets()).length).toBe(3);
  });
});
