// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 横幅文案必须整体跟随语言。
 *
 * 这些横幅（链接失败 / 只读 / 外部冲突 / 已被删除 / 保存失败）原先全是组件内硬编码，
 * 其中 5 处直接写死中文——切到 en-US 仍然显示中文。
 * `status-bar-i18n.test.ts` 只覆盖状态栏，所以这条缺口一直没有测试拦住。
 *
 * 这里用「从外部删除文件」触发横幅：它不依赖写权限（icacls）或对话框，
 * 走的是同一条 fs.watch → saveState('deleted') → 横幅渲染的链路。
 */
describe('横幅文案跟随语言', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-banner-i18n-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('文件被外部删除后横幅与按钮按当前语言渲染，切换语言即时刷新', async () => {
    const docPath = path.join(tempDir, 'banner.md');
    fs.writeFileSync(docPath, '# 标题\n\n正文。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    // locale 会经 localStorage 持久化到 Electron userData、跨用例残留，先钉死。
    const originalLocale = await app.evaluate<string>(`window.nexusLocale.locale`);
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);

    fs.unlinkSync(docPath);
    await app.waitForSelector('.nexus-warning-banner', 20000);

    const bannerText = () =>
      app.evaluate<string>(
        `document.querySelector('.nexus-warning-banner span')?.textContent ?? ''`
      );
    const saveAsLabel = () =>
      app.evaluate<string>(`document.querySelector('.nexus-banner-saveas-btn')?.textContent ?? ''`);

    // 用整串比对而不是 includes：只查关键字的话，「文案还是硬编码的中文」也会通过。
    await app.waitForFunction(
      `() => (document.querySelector('.nexus-warning-banner span')?.textContent ?? '').startsWith('The file was deleted')`,
      20000
    );
    expect((await bannerText()).trim()).toBe(
      'The file was deleted or moved outside Nexus. Use Save As now to avoid losing your work.'
    );
    expect((await saveAsLabel()).trim()).toBe('Save As');

    await app.evaluate(`(() => { window.nexusLocale.setLocale('zh-CN'); return true; })()`);
    await app.waitForFunction(
      `() => (document.querySelector('.nexus-warning-banner span')?.textContent ?? '').startsWith('文件已被外部删除')`,
      20000
    );
    expect((await bannerText()).trim()).toBe('文件已被外部删除或移动。请尽快另存为以防数据丢失。');
    expect((await saveAsLabel()).trim()).toBe('另存为');

    // 必须还原：locale 落在 localStorage 里，会跟着 userData 泄漏到后续所有用例。
    // 留在 zh-CN 会让断言英文标签的用例（mermaid-visual 的 `toBe('Source')` 等）
    // 在「单跑绿、全跑红」的形态下随机失败。
    await app.evaluate(
      `(() => { window.nexusLocale.setLocale(${JSON.stringify(originalLocale)}); return true; })()`
    );
    await app.waitForFunction(
      `() => window.nexusLocale.locale === ${JSON.stringify(originalLocale)}`,
      20000
    );
  }, 90000);
});
