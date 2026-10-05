// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { BASE16_SLOTS } from '@nexus/theme';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 用户主题目录（`<home>/.nexus/themes/`）的**端到端**验证。
 *
 * 为什么必须真机：这条链的每一段都只有启动时才成立 —— 主进程在**窗口创建之前**扫目录并把
 * 派生结果算好，preload 用 `sendSync` 同步取回、在首帧之前写 `data-theme` 与变量。三层各自
 * 的单测（`theme-directory.test.ts` / `theme-boot-payload.test.ts` / `theme-boot.test.ts`）
 * 谁都不知道这段接线有没有真的接上。
 *
 * ## 家目录由 harness 隔离
 *
 * 主进程读 `os.homedir()`，而它取的是子进程的 `USERPROFILE`（Windows）/ `HOME`（POSIX）——
 * harness 已经把每个实例的家目录指到 `<userDataDir>/home`，所以这里**不需要**自己重定向，
 * 用 `app.homeDir` 断言即可。见 `smoke-harness.ts` 的 `ElectronAppInstance.homeDir`。
 *
 * ## 三次断言塞进一次启动
 *
 * 真机用例一个文件只启动两次 Electron（同文件第二次启动会卡在 `Runtime.enable`，见
 * `MEMORY.md`）。所以第一次启动顺手把「用户选了哪套主题」写进 localStorage，第二次启动同时
 * 验三件事：目录不存在是常态、放进去的主题进列表且坏文件被单独标出、用户主题在首帧就生效。
 */

/** 与 `theme-directory.test.ts` 同一份手写 fixture：**逐字贴近上游**，不走自己的序列化器。 */
const PALETTE_DARK: Record<string, string> = Object.fromEntries(
  BASE16_SLOTS.map((slot, index) => [slot, `#${(index + 1).toString(16).padStart(2, '0')}0000`])
);

function base16Yaml(name: string, variant: 'light' | 'dark', palette = PALETTE_DARK): string {
  const lines = ['system: "base16"', `name: "${name}"`, `variant: "${variant}"`, 'palette:'];
  for (const slot of BASE16_SLOTS) lines.push(`  ${slot}: "${palette[slot]}"`);
  return `${lines.join('\n')}\n`;
}

/** 带上 `nexus.id` 的那一种 —— Nexus 自己写出去的文件长这样，上游文件没有这一段。 */
function managedYaml(id: string, name: string, variant: 'light' | 'dark'): string {
  return `${base16Yaml(name, variant)}nexus:\n  id: "${id}"\n`;
}

interface BootProbe {
  directory: string;
  themeIds: string[];
  broken: Array<{ fileName: string; reason: string }>;
  themeId: string;
  cssText: string;
  migrated: boolean;
  domTheme: string | undefined;
  injectedCss: string | null;
  staticCssLinked: boolean;
  canvasColour: string;
}

async function readBoot(app: ElectronAppInstance): Promise<BootProbe> {
  return app.evaluate<BootProbe>(`(() => {
    const boot = window.nexus.themeBoot;
    return {
      directory: boot.directory,
      themeIds: boot.themes.map((theme) => theme.id),
      broken: boot.broken,
      themeId: boot.themeId,
      cssText: boot.cssText,
      migrated: boot.migrated,
      domTheme: document.documentElement.dataset.theme,
      injectedCss: document.getElementById('nexus-theme-vars')?.textContent ?? null,
      staticCssLinked: Array.from(document.styleSheets).some(
        (sheet) => (sheet.href || '').endsWith('theme.css')
      ),
      canvasColour: getComputedStyle(document.documentElement)
        .getPropertyValue('--nexus-bg-canvas')
        .trim()
    };
  })()`);
}

describe('用户主题目录 · 启动链路', () => {
  let themesDir: string;
  let userDataDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    // 两次启动看同一份 localStorage **与同一份家目录**，所以 userData 目录必须复用
    // （harness 默认每次新建一个，家目录跟着它走）。
    userDataDir = createTempDir('nexus-userdata-theme-');
    themesDir = path.join(userDataDir, 'home', '.nexus', 'themes');
  });

  afterAll(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('目录不存在照常启动；放进目录的主题进列表、坏文件单独标出；用户主题首帧就生效', async () => {
    // ── 第一次启动：`~/.nexus/themes` 还不存在（真实用户的常态）────────────────
    activeApp = await launchElectronApp({ userDataDir });
    const first = activeApp;
    await first.waitForFunction(`() => Boolean(window.nexus?.themeBoot)`, 20000);

    const cold = await readBoot(first);

    // 目录路径由主进程算（`<home>/.nexus/themes`），而 `<home>` 只有它知道 —— 界面要显示它。
    expect(cold.directory).toBe(path.join(first.homeDir, '.nexus', 'themes'));
    expect(cold.directory).toBe(themesDir);
    expect(cold.themeIds).toEqual([]);
    expect(cold.broken).toEqual([]);
    expect(cold.migrated).toBe(true);

    // **出厂主题一个不少**：静态样式表还在（53 族都在它里面），`data-theme` 落在内置 id 上，
    // 且不需要注入变量 —— 内置主题有构建期 CSS，`cssText` 是空串。
    expect(cold.staticCssLinked).toBe(true);
    expect(cold.themeId).toMatch(/^nexus-(light|dark)$/);
    expect(cold.cssText).toBe('');
    expect(cold.domTheme).toBe(cold.themeId);
    expect(cold.canvasColour).not.toBe('');

    // **只读，不建目录**：从没放过主题文件的用户，启动一次不该在他家里凭空造出 `.nexus/themes`。
    expect(fs.existsSync(themesDir)).toBe(false);

    // 顺手把「用户选了哪套主题」写进存档 —— 下一次启动要验的就是它。
    // 走 `localStorage` 而不是 `nexusSettings`：`appearance.theme` 那套此刻还没有 `user:dracula`
    // 可选，直接写存档正是「上一次会话留下的选择」这个真实场景。
    await first.evaluate(`(() => {
      localStorage.setItem('nexus-theme', 'user:dracula');
      return true;
    })()`);
    // 必须优雅退出：`close()` 发 SIGTERM，Chromium 的 leveldb 提交不会跑，下一次启动读回来是空的。
    await first.closeGracefully();
    activeApp = null;

    // ── 放三份文件：上游格式（无 id）、Nexus 写的（带 id）、一份手改坏的 ──────────
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, 'dracula.yaml'), base16Yaml('Dracula', 'dark'), 'utf8');
    fs.writeFileSync(path.join(themesDir, 'mine.yaml'), managedYaml('user:mine', 'Mine', 'dark'), 'utf8');
    // 只有两个槽位 —— 手改漏了十四个，正是 `missing-slots` 的样子。
    fs.writeFileSync(
      path.join(themesDir, 'broken.yaml'),
      `name: "Broken"\nvariant: "dark"\npalette:\n  base00: "#123456"\n  base05: "#abcdef"\n`,
      'utf8'
    );

    // ── 第二次启动 ─────────────────────────────────────────────────────────
    activeApp = await launchElectronApp({ userDataDir });
    const second = activeApp;
    await second.waitForFunction(`() => Boolean(window.nexus?.themeBoot)`, 20000);

    const warm = await readBoot(second);

    // ① 上游文件按**文件名**推 id（`@` 会换成 `-`，这里没有），Nexus 写的按**文件里的 id**。
    //    坏文件不进列表 —— 能被选中的主题必须全部过了 16 槽校验。
    expect(warm.themeIds).toEqual(['user:dracula', 'user:mine']);

    // ② 坏文件被单独标出来，且**没有连累**其余两份。
    expect(warm.broken).toEqual([{ fileName: 'broken.yaml', reason: 'missing-slots' }]);

    // ③ 用户主题在首帧就生效：载荷带着派生好的 CSS，DOM 上是那套主题的 id 与变量。
    expect(warm.themeId).toBe('user:dracula');
    expect(warm.domTheme).toBe('user:dracula');
    expect(warm.cssText).toContain('--nexus-bg-canvas');
    // 用户主题**没有**构建期静态 CSS，所以变量只能来自注入。注入的那份与载荷逐字同形
    // （两边都从同一份 token 派生，`theme-boot-payload.ts` 的 `rootBlock` 与
    // `ThemeManager.applyToDOM` 是同形判据）—— 不同形的话首帧与第二帧会是两套主题。
    expect(warm.injectedCss).toBe(warm.cssText);
    expect(warm.canvasColour).not.toBe('');
    // 与内置主题的基线**不同**值才算真的换了主题：`#010000` 是 fixture 的 base00 派生物。
    expect(warm.canvasColour).not.toBe(cold.canvasColour);
  }, 180000);
});
