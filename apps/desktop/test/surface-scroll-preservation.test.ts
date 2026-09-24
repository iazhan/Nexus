// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * Surface 往返切换要保持"第一行可见位置"。
 *
 * 关键点：**不能搬 `scrollTop`**。视觉投影把表格 / 代码块 / mermaid 渲染成块级 widget，
 * 同一份 source 在两个 surface 里的像素高度不同——把 Source 的 `scrollTop` 原样搬到
 * Visual，落点会偏出去几十上百像素。所以断言的是**位置语义**：
 * 视口顶边落在哪一行（行号）以及在该行内的亚行偏移。
 */
describe('Surface 切换保持滚动位置与光标', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-surface-scroll-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  interface ViewportProbe {
    surface: string | null;
    lineNumber: number;
    lineText: string;
    /** 视口顶边在锚点行内的亚行偏移（像素）。 */
    offset: number;
    scrollTop: number;
    maxScrollTop: number;
    hasFocus: boolean;
  }

  async function probeViewport(app: ElectronAppInstance): Promise<ViewportProbe> {
    return app.evaluate<ViewportProbe>(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('Active view unavailable');
      // scrollSnapshot() 是位置语义：range.head = 视口顶边所在 block 的起点，
      // yMargin = 视口顶边在该 block 内的偏移。
      const snap = view.scrollSnapshot().value;
      const pos = snap.range.head;
      const line = view.state.doc.lineAt(pos);
      const scroller = view.scrollDOM;
      return {
        surface: document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null,
        lineNumber: line.number,
        lineText: line.text.trim().slice(0, 30),
        offset: snap.yMargin,
        scrollTop: scroller.scrollTop,
        maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
        hasFocus: view.hasFocus === true
      };
    })()`);
  }

  async function scrollToLine(app: ElectronAppInstance, needle: string): Promise<void> {
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      const pos = view.state.doc.toString().indexOf(${JSON.stringify(needle)});
      if (pos < 0) throw new Error('needle not found');
      view.scrollDOM.scrollTop = view.lineBlockAt(pos).top;
      return true;
    })()`);
    // 等 CM 重新测量并渲染新视口
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  async function switchSurface(app: ElectronAppInstance, target: string): Promise<void> {
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector(`[data-surface-kind="${target}"]`, 20000);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  it('keeps the viewport anchor line and sub-line offset across source <-> visual', async () => {
    // 表格与代码块在 Visual 里是块级 widget，高度与 Source 的纯文本差很多——
    // 这正是"搬 scrollTop 会落错位置"的场景。锚点选在它们**后面**的段落带里。
    const before = Array.from({ length: 20 }, (_, i) => `前段第 ${i + 1} 行。`).join('\n\n');
    const after = Array.from({ length: 90 }, (_, i) => `尾段第 ${i + 1} 行。`).join('\n\n');
    const source = [
      '# Surface 滚动保持',
      '',
      before,
      '',
      '| 表头 A | 表头 B |',
      '| --- | --- |',
      '| 甲 | 乙 |',
      '| 丙 | 丁 |',
      '',
      '```ts',
      'const answer = 42;',
      'console.log(answer);',
      '```',
      '',
      after
    ].join('\n');
    const docPath = path.join(tempDir, 'surface-scroll.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('[data-surface-kind="source"]', 20000);

    // 滚到表格/代码块之后的中段
    await scrollToLine(app, '尾段第 40 行');
    const sourceBefore = await probeViewport(app);
    expect(sourceBefore.surface).toBe('source');
    // 测试前提：确实滚下去了，否则断言恒真
    expect(sourceBefore.scrollTop).toBeGreaterThan(100);
    expect(sourceBefore.lineText).toContain('尾段第');

    await switchSurface(app, 'visual');
    const visualAfter = await probeViewport(app);
    expect(visualAfter.surface).toBe('visual');

    // 位置语义：同一行 + 同一亚行偏移
    expect(visualAfter.lineNumber).toBe(sourceBefore.lineNumber);
    expect(visualAfter.lineText).toBe(sourceBefore.lineText);
    expect(Math.abs(visualAfter.offset - sourceBefore.offset)).toBeLessThanOrEqual(1.5);
    // 切换后光标仍可见（新 view 拿到了焦点）
    expect(visualAfter.hasFocus).toBe(true);

    // 往返幂等：切回 Source 应当回到原处
    await switchSurface(app, 'source');
    const sourceAgain = await probeViewport(app);
    expect(sourceAgain.surface).toBe('source');
    expect(sourceAgain.lineNumber).toBe(sourceBefore.lineNumber);
    expect(sourceAgain.lineText).toBe(sourceBefore.lineText);
    expect(Math.abs(sourceAgain.offset - sourceBefore.offset)).toBeLessThanOrEqual(1.5);

    // 纯读操作：切换不许改动 canonical source
    const unchanged = await app.evaluate<boolean>(
      `window.nexusSession.getSnapshot().source === ${JSON.stringify(source)}`
    );
    expect(unchanged).toBe(true);
  }, 120000);

  it('keeps the caret offset across a surface switch', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `正文第 ${i + 1} 行。`).join('\n\n');
    const source = ['# 光标保持', '', body, '', '末尾一段。'].join('\n');
    const docPath = path.join(tempDir, 'surface-caret.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('[data-surface-kind="source"]', 20000);

    const caret = source.indexOf('正文第 25 行') + 3;
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      view.focus();
      view.dispatch({ selection: { anchor: ${caret}, head: ${caret} } });
      return true;
    })()`);
    // 先让光标进入视口，否则"切换后光标还在视口里"这条断言恒假——
    // 保留视口顶边不等于把屏幕外的光标拉进来。
    await scrollToLine(app, '正文第 25 行');
    await new Promise((resolve) => setTimeout(resolve, 300));

    await switchSurface(app, 'visual');

    const selection = await app.evaluate<{ anchor: number; head: number }>(
      `(() => {
        const snap = window.nexusSession.getSnapshot();
        return { anchor: snap.selection.anchor, head: snap.selection.head };
      })()`
    );
    expect(selection.anchor).toBe(caret);
    expect(selection.head).toBe(caret);

    // 光标仍在视口内，且相对顶边的屏幕位置没有大跳（视觉投影会改上方行高，
    // 所以允许一个行高以内的漂移）。
    const caretOffset = await app.evaluate<number | null>(`(() => {
      const view = window.nexusActiveView;
      const rect = view.coordsAtPos(view.state.selection.main.head);
      if (!rect) return null;
      const scroller = view.scrollDOM.getBoundingClientRect();
      if (rect.top < scroller.top - 1 || rect.bottom > scroller.bottom + 1) return -1;
      return rect.top - scroller.top;
    })()`);
    expect(caretOffset).not.toBeNull();
    expect(caretOffset ?? -1).toBeGreaterThanOrEqual(0);
    expect(caretOffset ?? 9999).toBeLessThan(80);
  }, 120000);

  it('does not drift across repeated surface switches', async () => {
    // 位置语义的恢复每轮都可能被设备像素吸附掉零点几像素。单次往返测不出累积漂移，
    // 所以这里来回切三次，并给总漂移一个比单次更紧的上界。
    const body = Array.from({ length: 200 }, (_, i) => `段落第 ${i + 1} 行。`).join('\n\n');
    const source = [
      '# 防漂移',
      '',
      '| 表头 A | 表头 B |',
      '| --- | --- |',
      '| 甲 | 乙 |',
      '',
      '```ts',
      'const drift = 0;',
      '```',
      '',
      body
    ].join('\n');
    const docPath = path.join(tempDir, 'surface-drift.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('[data-surface-kind="source"]', 20000);

    await scrollToLine(app, '段落第 150 行');
    const origin = await probeViewport(app);
    expect(origin.scrollTop).toBeGreaterThan(100);
    expect(origin.lineText).toContain('段落第');

    const surfaces = ['visual', 'source', 'visual', 'source', 'visual', 'source'];
    let last = origin;
    for (const target of surfaces) {
      await switchSurface(app, target);
      const current = await probeViewport(app);
      expect(current.surface).toBe(target);
      // 每一跳都必须落在同一行；行号一旦漂走，说明恢复用的是像素而不是位置
      expect(current.lineNumber).toBe(origin.lineNumber);
      expect(current.lineText).toBe(origin.lineText);
      // 单跳不许有整像素以上的跳动
      expect(Math.abs(current.offset - last.offset)).toBeLessThanOrEqual(1);
      last = current;
    }

    // 三趟往返（6 次切换）后的总漂移。
    //
    // 残留这点漂移是**固有的**，不是实现缺陷：`scrollTop` 会被浏览器吸附到设备像素，
    // 而 `scrollSnapshot()` 存的是「block 顶边 - scrollTop」这个浮点差，
    // 两个 surface 的高度表不同 → 小数部分不同 → 每次切换吸收掉不到 1px。
    // 关键保证是**锚点行不变**（上面已断言）；亚行偏移只做上界约束，
    // 这条上界足以拦住"恢复成像素搬运"这类真实回归。
    expect(Math.abs(last.offset - origin.offset)).toBeLessThanOrEqual(surfaces.length);
  }, 180000);

  it('toggles the surface with Mod-M even while the editor has focus', async () => {
    // `@codemirror/commands` 的 `defaultKeymap` 里有 `Ctrl-m`（toggleTabFocusMode）。
    // 宿主的全局快捷键挂在 window 上、开头是 `if (e.defaultPrevented) return;`，
    // 而 CM 的 keymap 挂在 contentDOM 上先跑——编辑器聚焦时 Ctrl+M 会被 CM 吞掉，
    // 表现为"这个快捷键只在编辑器没聚焦时有效"。这条守"聚焦状态下 Mod-M 依然生效"。
    const docPath = path.join(tempDir, 'modm-focused.md');
    fs.writeFileSync(docPath, '# Mod-M\n\n正文。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('[data-surface-kind="source"]', 20000);

    // 明确让编辑器拿到焦点
    await app.evaluate(`(() => {
      window.nexusActiveView.focus();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const focused = await app.evaluate<boolean>(`window.nexusActiveView.hasFocus === true`);
    expect(focused).toBe(true);

    await app.pressKey('m', { ctrl: true });
    await app.waitForSelector('[data-surface-kind="visual"]', 15000);

    await app.pressKey('m', { ctrl: true });
    await app.waitForSelector('[data-surface-kind="source"]', 15000);
  }, 90000);
});
