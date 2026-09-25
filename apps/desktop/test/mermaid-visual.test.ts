// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 视觉模式下的 Mermaid 块。
 *
 * 它是**整块一个 widget**（`.cm-visual-code-block`），走不了普通代码块那套逐行装饰，
 * 所以卡片外观、按钮的显示规则都要单独覆盖。
 *
 * 显示模式由 `pin + 光标` 派生（见 `isMermaidSourceMode`）：
 * - header 上的按钮写 `pin`，**粘性** —— 默认路径
 * - 点预览图只在设置打开时才揭示，**瞬时** —— 光标一离开就回预览
 */
describe('视觉模式 Mermaid 块', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mermaid-visual-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  const SOURCE = [
    '# 图',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
    '后段正文。'
  ].join('\n');

  async function openVisual(docName: string, clickToReveal = false) {
    const docPath = path.join(tempDir, docName);
    fs.writeFileSync(docPath, SOURCE, 'utf-8');
    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
    await app.waitForSelector('.cm-mermaid-preview svg', 20000);
    // 显式设定偏好，避免上一个用例持久化到 localStorage 的值泄漏进来
    await app.evaluate(
      `(() => { window.nexusMermaidPreview.set(${clickToReveal}); return true; })()`
    );
    // 主题样式是后注入的，按钮的 opacity 会从初始值过渡到 0 —— 等它落定再断言，
    // 否则 getComputedStyle 读到的是过渡中间值（实测 0.51）。
    await app.waitForFunction(
      `() => getComputedStyle(document.querySelector('.cm-mermaid-toggle')).opacity === '0'`
    );
    return app;
  }

  const style = (app: ElectronAppInstance, selector: string, prop: string) =>
    app.evaluate<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el)[${JSON.stringify(prop)}] : null; })()`
    );

  const count = (app: ElectronAppInstance, selector: string): Promise<number> =>
    app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

  const hoverBlock = async (app: ElectronAppInstance) => {
    const point = await app.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('.cm-visual-code-block').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await app.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      buttons: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
  };

  /** 点标题行把光标移出块外（点行号栏不会移动光标）。 */
  const leaveBlock = async (app: ElectronAppInstance) => {
    const point = await app.evaluate<{ x: number; y: number }>(`(() => {
      const line = Array.from(document.querySelectorAll('.cm-line'))
        .find((el) => (el.textContent || '').includes('图'));
      const r = line.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
    })()`);
    await app.mouseClickCoords(point.x, point.y);
  };

  const toggleLabel = (app: ElectronAppInstance) =>
    app.evaluate<string | null>(`document.querySelector('.cm-mermaid-toggle')?.textContent ?? null`);

  it('渲染成与代码块一致的卡片，按钮默认隐藏、悬停才出现', async () => {
    const app = await openVisual('card.md');

    expect(await style(app, '.cm-visual-code-block', 'borderTopWidth')).toBe('1px');
    expect(await style(app, '.cm-visual-code-block', 'borderTopLeftRadius')).toBe('6px');
    expect(await style(app, '.cm-code-header', 'height')).toBe('28px');
    expect(await style(app, '.cm-code-header', 'display')).toBe('flex');
    expect(
      await app.evaluate<string>(`document.querySelector('.cm-code-language').textContent`)
    ).toBe('mermaid');
    expect(await count(app, '.cm-mermaid-preview svg')).toBe(1);

    // 两个按钮都默认隐藏；旧的选择器只匹配 `.cm-visual-code-header-line` /
    // `.cm-code-header-widget`，而 Mermaid 预览态里两者都不存在，
    // 少了 `.cm-visual-code-block:hover` 这条复制按钮会**永远显示不出来**。
    expect(await style(app, '.cm-mermaid-toggle', 'opacity')).toBe('0');
    expect(await style(app, '.cm-code-copy-btn', 'opacity')).toBe('0');
    await hoverBlock(app);
    expect(await style(app, '.cm-mermaid-toggle', 'opacity')).toBe('1');
    expect(await style(app, '.cm-code-copy-btn', 'opacity')).toBe('1');
  }, 90000);

  it('按钮是默认路径：切源码后钉住，光标移开仍是源码，再点回预览', async () => {
    const app = await openVisual('toggle.md');

    expect(await toggleLabel(app)).toBe('Source');
    await hoverBlock(app);
    await app.mouseClick('.cm-mermaid-toggle');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-code-block').length === 0`
    );
    // 揭示态走普通代码块的逐行装饰
    expect(await count(app, '.cm-visual-code-header-line')).toBe(1);
    // 揭示态的 header 上也要有按钮，否则切不回预览
    expect(await toggleLabel(app)).toBe('Preview');

    // **粘性**：光标移出块外仍然是源码
    await leaveBlock(app);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await count(app, '.cm-visual-code-block')).toBe(0);
    expect(await count(app, '.cm-visual-code-header-line')).toBe(1);

    // 点回预览
    await app.mouseClick('.cm-mermaid-toggle');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-mermaid-preview svg').length === 1`
    );
  }, 90000);

  it('源码可编辑：切到源码后打字会写回 session', async () => {
    const app = await openVisual('edit.md');

    expect(await app.evaluate<string>(`window.nexusSession.getSnapshot().source`)).toBe(SOURCE);

    await hoverBlock(app);
    await app.mouseClick('.cm-mermaid-toggle');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-code-block').length === 0`
    );

    // 点进源码正文，光标落在真实文本上
    const contentPoint = await app.evaluate<{ x: number; y: number }>(`(() => {
      const line = Array.from(document.querySelectorAll('.cm-line'))
        .find((el) => (el.textContent || '').includes('flowchart TD'));
      const r = line.getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
    })()`);
    await app.mouseClickCoords(contentPoint.x, contentPoint.y);
    await app.typeText('X');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('Xflowchart TD')`
    );
  }, 90000);

  it('设置关闭时（默认），点预览图不揭示源码', async () => {
    const app = await openVisual('click-off.md', false);

    await app.mouseClick('.cm-mermaid-preview');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 仍在预览态
    expect(await count(app, '.cm-mermaid-preview svg')).toBe(1);
    expect(await count(app, '.cm-visual-code-header-line')).toBe(0);
  }, 90000);

  it('设置打开后，点预览图揭示源码，光标移开自动回预览', async () => {
    const app = await openVisual('click-on.md', true);

    await app.mouseClick('.cm-mermaid-preview');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-code-block').length === 0`
    );

    // **瞬时**：光标一离开就回预览（与按钮的粘性相对）
    await leaveBlock(app);
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-mermaid-preview svg').length === 1`
    );
  }, 90000);

  it('按钮文案跟随语言，切语言后即时刷新', async () => {
    const app = await openVisual('i18n.md');

    // locale 落在 localStorage 里、跟着 Electron userData 跨文件与跨用例残留。
    // 不先钉死，「默认 en-US」断言读到的就是上一个用例的遗留值。
    const originalLocale = await app.evaluate<string>(`window.nexusLocale.locale`);
    await app.evaluate(`(() => { window.nexusLocale.setLocale('en-US'); return true; })()`);
    await app.waitForFunction(
      `() => document.querySelector('.cm-mermaid-toggle')?.textContent === 'Source'`
    );

    const labels = () =>
      app.evaluate<{ toggle: string | null; copy: string | null; copyAria: string | null }>(
        `(() => {
          const toggle = document.querySelector('.cm-mermaid-toggle');
          const copy = document.querySelector('.cm-code-copy-btn');
          return {
            toggle: toggle?.textContent ?? null,
            copy: copy?.querySelector('.cm-code-copy-label')?.textContent ?? null,
            copyAria: copy?.getAttribute('aria-label') ?? null
          };
        })()`
      );

    // 默认 en-US
    expect(await labels()).toEqual({ toggle: 'Source', copy: 'Copy', copyAria: 'Copy code' });

    // 切到中文：投影重建时 widget 的 eq() 会因为 locale 不同而失效 → 重新建 DOM，
    // 文案立即刷新（不这么做会留着旧语言，因为 CM 会复用 widget 的 DOM）
    await app.evaluate(`(() => { window.nexusLocale.setLocale('zh-CN'); return true; })()`);
    await app.waitForFunction(
      `() => document.querySelector('.cm-mermaid-toggle')?.textContent === '源码'`
    );
    expect(await labels()).toEqual({ toggle: '源码', copy: '复制', copyAria: '复制代码' });

    // 切到源码态后按钮文案也要跟着语言走
    await hoverBlock(app);
    await app.mouseClick('.cm-mermaid-toggle');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-code-block').length === 0`
    );
    expect(
      await app.evaluate<string | null>(`document.querySelector('.cm-mermaid-toggle')?.textContent ?? null`)
    ).toBe('预览');

    // 必须还原：留在 zh-CN 会污染本文件后续用例（Appearance 菜单按标签查找）
    // 以及后面所有断言英文文案的文件。
    await app.evaluate(
      `(() => { window.nexusLocale.setLocale(${JSON.stringify(originalLocale)}); return true; })()`
    );
    await app.waitForFunction(
      `() => window.nexusLocale.locale === ${JSON.stringify(originalLocale)}`,
      20000
    );
  }, 90000);

  it('Appearance 菜单里的开关能打开「点击图表显示源码」', async () => {
    const app = await openVisual('menu.md', false);

    expect(await app.evaluate<boolean>(`window.nexusMermaidPreview.get()`)).toBe(false);

    // 打开 Appearance 菜单
    const menuButton = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const btn = Array.from(document.querySelectorAll('.nexus-menu-bar-button'))
        .find((el) => (el.textContent || '').trim() === 'Appearance');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    expect(menuButton).not.toBeNull();
    await app.mouseClickCoords(menuButton!.x, menuButton!.y);
    await app.waitForSelector('.nexus-menu-dropdown');

    // 开关项默认未勾选
    const item = await app.evaluate<{ x: number; y: number; active: boolean } | null>(`(() => {
      const el = Array.from(document.querySelectorAll('.nexus-menu-item'))
        .find((n) => (n.textContent || '').includes('Click diagram to show source'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        active: el.classList.contains('active')
      };
    })()`);
    expect(item).not.toBeNull();
    expect(item!.active).toBe(false);
    await app.mouseClickCoords(item!.x, item!.y);

    // 偏好翻转，行为立即生效
    await app.waitForFunction(`() => window.nexusMermaidPreview.get() === true`);
    await app.mouseClick('.cm-mermaid-preview');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-code-block').length === 0`
    );
  }, 90000);

  it('预览态下，块下方内容的点击命中不漂移', async () => {
    const app = await openVisual('drift.md');

    const hit = await app.evaluate<string | null>(`(() => {
      const view = window.nexusActiveView;
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const target = lines.find((el) => (el.textContent || '').includes('后段正文。'));
      if (!target) return null;
      const r = target.getBoundingClientRect();
      const pos = view.posAtCoords({ x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) });
      return pos !== null ? view.state.doc.lineAt(pos).text : null;
    })()`);

    expect(hit).toContain('后段正文。');
  }, 90000);
});
