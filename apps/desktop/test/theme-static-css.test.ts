// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 静态 CSS 必须**独立**提供主题变量。
 *
 * 这是「首屏无闪烁」的真正判据：preload 在 9.6ms 就写了 `data-theme`（plan §4.4.1），但那时
 * renderer 还没跑、`<style id="nexus-theme-vars">` 还不存在 —— 变量若只来自那次运行时注入，
 * 属性写了也没人消费，首帧照样是默认主题。
 *
 * 所以判据不能是「变量读得到」（运行时注入也读得到），而是「**删掉运行时注入后变量仍读得到**」。
 * 顺带锁住 `<link>` 还在 index.html 里：少了它应用照常能用、只是又开始闪，没有别的测试会失败。
 */
describe('内置主题的静态 CSS', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-theme-css-');
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

  it('删掉 renderer 的运行时注入后，变量仍由静态样式表提供', async () => {
    const filePath = path.join(tempDir, 'theme.md');
    fs.writeFileSync(filePath, '# 主题\n\n静态 CSS 的判据。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    const probe = await app.evaluate<{
      linked: boolean;
      theme: string | undefined;
      before: string;
      after: string;
    }>(`(() => {
      const root = document.documentElement;
      const read = () => getComputedStyle(root).getPropertyValue('--nexus-bg-canvas').trim();
      const linked = Array.from(document.styleSheets).some(
        (sheet) => (sheet.href || '').endsWith('theme.css')
      );
      const before = read();
      document.getElementById('nexus-theme-vars')?.remove();
      return { linked, theme: root.dataset.theme, before, after: read() };
    })()`);

    expect(probe.linked).toBe(true);
    expect(probe.theme).toBeTruthy();
    expect(probe.before).not.toBe('');
    // 删掉运行时注入后值不变 —— 说明变量是静态样式表给的，不是那次注入给的
    expect(probe.after).toBe(probe.before);
  });
});
