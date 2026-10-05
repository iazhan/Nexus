// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  launchElectronApp,
  createTempDir,
  readFileTolerant,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 日志系统的真机接线。
 *
 * 四件事只有真机能证：
 *
 * 1. **日志真的落到了盘上**（`<userData>/logs/nexus.log`）—— 启动那条 `info` 在里面。
 *    这是「打包之后用户还能拿到现场」这句话的全部依据；`log-file.test.ts` 只证明写盘器
 *    会写，不证明**主进程真的装了它**。
 * 2. **渲染进程的日志进的是同一个文件**。渲染进程没有文件系统，它的消息要经 `writeLog`
 *    走到主进程 —— 而这条链路跨了两个进程、一层 preload 和一次 console 接管，
 *    任何一环断了都只剩「DevTools 里有、盘上没有」。
 * 3. **设置页给得出级别与日志目录**（两个字段都画得出来，目录是主进程算的那条路径）。
 * 4. **级别真的生效**：调到「仅错误」之后 `console.warn` 不再进文件，而 `console.error` 照样进。
 *    这一条跨进程（设置住在渲染进程的存储里、写盘的是主进程），是这一项唯一实际的效果。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条链塞进同一个用例。
 */
describe('日志', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-log-directory-');
  });

  afterAll(() => {
    // `createTempDir` 登记过，退出钩子会删 —— 这里只做一次显式回收，失败不影响用例结论。
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 交给退出钩子 */
    }
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  /** 轮询等待。**不能用 harness 的 `waitForFunction`** —— 它把表达式包成同步函数，等不了异步。 */
  async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('等待超时');
  }

  it('日志落盘、渲染进程的消息也进同一个文件、级别真的生效', async () => {
    activeApp = await launchElectronApp();
    const app = activeApp;

    const logFile = path.join(app.userDataDir, 'logs', 'nexus.log');
    const read = (): string => readFileTolerant(logFile) ?? '';

    // ① 启动那条 info 日志落到了盘上。`<userData>/logs/nexus.log` 这个位置本身就是判据的一部分：
    //    它是设置页那个只读值要显示的东西，也是用户会去翻的地方。
    await waitFor(() => read().includes('Initialized launch context'), 20000);

    // ② 设置窗口的 data 段里有这两项
    await app.waitForSelector('.nexus-header-bar', 20000);
    await app.evaluate(`window.nexus.openSettingsWindow()`);
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);

    await app.click('.nexus-settings-nav [data-section="data"]');
    await app.waitForSelector('[data-field-input="data.logLevel"]', 10000);

    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-field-input="data.logLevel"]').tagName`
      )
    ).toBe('SELECT');

    // ③ 只读值显示的是主进程算的那条**文件**路径 —— 不是渲染进程自己拼的
    await app.waitForSelector('[data-field-readonly="data.openLogsDirectory"]', 10000);
    const shown = await app.evaluate<string>(
      `document.querySelector('[data-field-readonly="data.openLogsDirectory"]').textContent`
    );
    expect(shown).toContain('logs');
    expect(shown).toContain('nexus.log');

    // ④ 渲染进程的日志进的是**同一个**文件。这条同时证明了 console 接管、preload 桥、
    //    以及主进程那个 `writeLog` handler 三件事都通。
    await app.evaluate(`console.error('来自渲染进程的探针')`);
    await waitFor(() => read().includes('来自渲染进程的探针'), 10000);
    expect(read()).toContain('[error] 来自渲染进程的探针');

    // ⑤ 级别调到「仅错误」，然后验证它真的到了主进程
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-field-input="data.logLevel"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'error');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    // 让设置经「渲染进程 → 主进程」走完。没有可等的信号（`hostSettingsSynced` 不在桥上），
    // 所以这里让出一段时间 —— 而下面断言的是「warn 没写进去」，一个更早的失败方向会让
    // 用例变红而不是变绿，所以它不会掩盖问题。
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await app.evaluate(`console.warn('不该被记下来的警告')`);
    await app.evaluate(`console.error('该被记下来的错误')`);

    await waitFor(() => read().includes('该被记下来的错误'), 10000);
    // 正反两面：`error` 还在（上面那条等到了），而 `warn` 被级别挡掉了。
    expect(read()).not.toContain('不该被记下来的警告');
  }, 120000);
});
