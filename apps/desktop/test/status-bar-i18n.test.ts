// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 状态栏文案必须整体跟随语言。
 *
 * 之前只有保存状态走了 i18n，`Ln / Col` 与 `(N selected)` 是硬编码英文，
 * 中文界面下会出现"已保存 · Ln 1, Col 1"这种混排。
 */
describe('状态栏文案跟随语言', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-status-i18n-');
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('切换语言后行/列指标即时刷新，专有名词保持不变', async () => {
    const docPath = path.join(tempDir, 'status.md');
    fs.writeFileSync(docPath, '# 标题\n\n正文。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    const metrics = () =>
      app.evaluate<{ metrics: string[]; format: string | null }>(`(() => ({
        metrics: Array.from(document.querySelectorAll('.status-bar-right .status-metric'))
          .map((el) => el.textContent ?? ''),
        format: document.querySelector('.status-format')?.textContent ?? null
      }))()`);

    // locale 落在 localStorage 里、跟着 Electron userData 跨文件残留：
    // 不先钉死，`toBe('Ln 1, Col 1')` 断言的就不是应用默认值，而是上一个用例的遗留值。
    const originalLocale = await app.evaluate<string>(`window.nexusLocale.locale`);
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);
    await app.waitForFunction(`() => window.nexusLocale.locale === 'en-US'`, 20000);

    // 默认 en-US
    expect((await metrics()).metrics[0]).toBe('Ln 1, Col 1');

    await app.evaluate(`(() => { window.nexusLocale.setLocale('zh-CN'); return true; })()`);
    await app.waitForFunction(
      `() => document.querySelector('.status-bar-right .status-metric')?.textContent === '第 1 行，第 1 列'`
    );

    // 专有名词两种语言都一样
    expect((await metrics()).format).toBe('Markdown');

    // 必须还原，否则 zh-CN 会泄漏给后续所有断言英文文案的用例。
    await app.evaluate(
      `(() => { window.nexusLocale.setLocale(${JSON.stringify(originalLocale)}); return true; })()`
    );
    await app.waitForFunction(
      `() => window.nexusLocale.locale === ${JSON.stringify(originalLocale)}`,
      20000
    );
  }, 90000);
});
