// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { launchElectronApp, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 视觉模式下的公式就地编辑（真实 Electron）。
 *
 * 行内公式：点渲染体 → 光标进范围内部 → `$...$` 变回真实文本，直接改，无需浮层。
 * 块级公式：点渲染体 → `$$` 行可编辑 + 块尾追加实时预览，源码与渲染结果并存。
 *
 * 这两条必须跑真实 Electron：激活手势挂在 mousedown 上，而 happy-dom 会在 CM 写 DOM
 * 选区时同步派发 selectionchange，让 CM 的 observer 重入 dispatch（真实浏览器是异步排队）。
 */
describe('视觉模式公式就地编辑', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-math-inplace-'));
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  async function openVisual(app: ElectronAppInstance): Promise<void> {
    await app.waitForSelector('.cm-content', 20000);
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
  }

  async function readState(
    app: ElectronAppInstance
  ): Promise<{ source: string; anchor: number }> {
    return app.evaluate<{ source: string; anchor: number }>(`(() => {
      const snap = window.nexusSession.getSnapshot();
      return { source: snap.source, anchor: snap.selection.anchor };
    })()`);
  }

  const count = (app: ElectronAppInstance, selector: string): Promise<number> =>
    app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

  it('行内公式：点渲染体露出源码，直接改，光标移出后回到渲染态', async () => {
    const source = '# 公式\n\n能量 $E = mc^2$ 守恒。\n';
    const docPath = path.join(tempDir, 'inline-math.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await openVisual(app);

    // 渲染态：整节点 widget，没有源码 mark
    expect(await count(app, '.cm-visual-inline-math')).toBe(1);
    expect(await count(app, '.cm-visual-inline-math-source')).toBe(0);

    // 点击渲染体（激活手势挂在 mousedown）
    await app.mouseClick('.cm-visual-inline-math');
    await app.waitForSelector('.cm-visual-inline-math-source', 10000);

    // 渲染 widget 消失，定界符露出来，光标落在公式内部
    expect(await count(app, '.cm-visual-inline-math')).toBe(0);
    const from = source.indexOf('$');
    expect((await readState(app)).anchor).toBe(from + 1);
    expect(
      await app.evaluate<string>(
        `Array.from(document.querySelectorAll('.cm-visual-delimiter-revealed'), (el) => el.textContent).join('')`
      )
    ).toBe('$$');

    // 直接在源码里打字——不是往浮层输入框里打
    await app.typeText('x');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source === '# 公式\\n\\n能量 $xE = mc^2$ 守恒。\\n'`
    );

    // 光标移出公式范围后回到渲染态
    await app.pressKey('End');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-visual-inline-math').length === 1`
    );
    expect(await count(app, '.cm-visual-inline-math-source')).toBe(0);
  }, 90000);

  it('块级公式：源码与实时预览并存，改源码时预览跟着更新', async () => {
    const source = '# 块级公式\n\n$$\nE = mc^2\n$$\n\n后段正文。\n';
    const docPath = path.join(tempDir, 'block-math.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await openVisual(app);

    // 渲染态：整块替换
    expect(await count(app, '.cm-visual-block-math:not(.cm-visual-block-math-preview)')).toBe(1);
    expect(await count(app, '.cm-visual-block-math-preview')).toBe(0);

    await app.mouseClick('.cm-visual-block-math');
    await app.waitForSelector('.cm-visual-block-math-preview', 10000);

    // 整块替换消失、`$$` 行变回真实文本，预览与源码并存
    expect(await count(app, '.cm-visual-block-math:not(.cm-visual-block-math-preview)')).toBe(0);
    const lineText = await app.evaluate<string>(
      `Array.from(document.querySelectorAll('.cm-line'), (el) => el.textContent ?? '').join('\\n')`
    );
    expect(lineText).toContain('$$');
    expect(lineText).toContain('E = mc^2');

    const previewBefore = await app.evaluate<string>(
      `document.querySelector('.cm-visual-block-math-preview').innerHTML`
    );

    // 直接在公式行里打字（光标落在起始 `$$` 之后）
    await app.typeText('3');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('$$3')`
    );

    // 实时预览跟着更新（这正是旧 textarea 方案丢掉的东西）
    await app.waitForFunction(
      `() => document.querySelector('.cm-visual-block-math-preview') &&
             document.querySelector('.cm-visual-block-math-preview').innerHTML !== ${JSON.stringify(
               previewBefore
             )}`,
      10000
    );

    // 预览仍在，源码仍可继续编辑
    expect(await count(app, '.cm-visual-block-math-preview')).toBe(1);
    expect(await count(app, '.cm-visual-block-math:not(.cm-visual-block-math-preview)')).toBe(0);
  }, 90000);

  it('块级公式下方的内容点击命中不漂移（渲染态与编辑态都要准）', async () => {
    // 回归：KaTeX 的 display 模式给 `.katex-display` 加 `margin: 1em 0`，
    // 而块级 widget 的高度测量只算 offsetHeight、不含 margin。margin 塌陷到容器外，
    // CM 就认为公式块比实际矮 2em，下方所有内容的命中区整体下移——
    // 症状是"必须点目标行的上方"。表格漂移当年也是同一类问题（margin 改 padding）。
    const source = [
      '# 坐标',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '公式下方第一行。',
      '',
      '公式下方第二行。',
      '',
      '公式下方第三行。'
    ].join('\n');
    const docPath = path.join(tempDir, 'block-math-drift.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await openVisual(app);

    interface HitInfo {
      x: number;
      y: number;
      lineAtTarget: string | null;
    }

    // 量目标行中心的命中结果。漂移时 posAtCoords 会落到**下一行**。
    const probeHit = async (): Promise<HitInfo | null> =>
      app.evaluate<HitInfo | null>(`(() => {
        const view = window.nexusActiveView;
        const lines = Array.from(document.querySelectorAll('.cm-line'));
        const target = lines.find((el) => (el.textContent || '').includes('公式下方第二行。'));
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + 30);
        const y = Math.round(rect.top + rect.height / 2);
        const pos = view.posAtCoords({ x, y });
        return {
          x,
          y,
          lineAtTarget: pos !== null ? view.state.doc.lineAt(pos).text : null
        };
      })()`);

    const assertNoDrift = (info: HitInfo | null, label: string) => {
      expect(info, label).not.toBeNull();
      // 命中区必须落在目标行上。目标行下面特意留了一行——否则漂移 28px 之后
      // posAtCoords 仍会解析回同一行（文档末行），断言恒真。
      expect(info!.lineAtTarget, label).toContain('公式下方第二行。');
    };

    assertNoDrift(await probeHit(), '渲染态');

    // 真实点击：光标必须落到目标行
    const rendered = await probeHit();
    await app.mouseClickCoords(rendered!.x, rendered!.y);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const caretLine = await app.evaluate<string>(`(() => {
      const view = window.nexusActiveView;
      return view.state.doc.lineAt(view.state.selection.main.head).text;
    })()`);
    expect(caretLine).toContain('公式下方第二行。');

    // 编辑态：块尾多一个实时预览 widget，下方同样不能漂
    await app.mouseClick('.cm-visual-block-math');
    await app.waitForSelector('.cm-visual-block-math-preview', 10000);
    assertNoDrift(await probeHit(), '编辑态（含实时预览）');
  }, 90000);

  it('块级公式首尾两行的空白区点得进去，不会一碰就退出编辑态', async () => {
    // 回归：`range.from` / `range.to` 恰好是首行行首与闭合 `$$` 行的行尾。
    // 严格揭示判据（光标必须落在范围**内部**）在这两个位置上不成立，
    // 于是点击闭合行 `$$` 右侧的空白区会把光标贴到行尾 → 块立刻折叠回渲染体，
    // 用户看到的是"最后一行点不进去、一点就退出编辑"。首行左侧同理。
    const source = ['$$', 'E = mc^2', '$$', '', '后段正文。'].join('\n');
    const docPath = path.join(tempDir, 'block-math-edges.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await openVisual(app);

    const isRevealed = async (): Promise<boolean> =>
      (await count(app, '.cm-visual-block-math-preview')) === 1 &&
      (await count(app, '.cm-visual-block-math:not(.cm-visual-block-math-preview)')) === 0;

    // 先进入编辑态
    await app.mouseClick('.cm-visual-block-math');
    await app.waitForSelector('.cm-visual-block-math-preview', 10000);
    expect(await isRevealed()).toBe(true);

    // 点击**闭合 `$$` 行右侧的空白区**：光标会贴到该行行尾（= range.to）
    const closeLine = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const fences = lines.filter((el) => (el.textContent || '').trim() === '$$');
      const close = fences[fences.length - 1];
      if (!close) return null;
      const rect = close.getBoundingClientRect();
      return { x: Math.round(rect.right - 30), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    expect(closeLine).not.toBeNull();
    await app.mouseClickCoords(closeLine!.x, closeLine!.y);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 光标确实落在闭合行行尾（说明这条用例真的压到了边界）
    const caretAtCloseLineEnd = await app.evaluate<boolean>(`(() => {
      const view = window.nexusActiveView;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return line.text.trim() === '$$' && head === line.to;
    })()`);
    expect(caretAtCloseLineEnd).toBe(true);
    // 而且没有退出编辑态
    expect(await isRevealed()).toBe(true);

    // 首行左侧空白区同理
    const openLine = await app.evaluate<{ x: number; y: number } | null>(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const fences = lines.filter((el) => (el.textContent || '').trim() === '$$');
      const open = fences[0];
      if (!open) return null;
      const rect = open.getBoundingClientRect();
      return { x: Math.round(rect.right - 30), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    expect(openLine).not.toBeNull();
    await app.mouseClickCoords(openLine!.x, openLine!.y);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await isRevealed()).toBe(true);

    // 真正移出块外才折叠回渲染体（守"揭示范围没有过度放宽"）
    await app.mouseClickCoords(closeLine!.x, closeLine!.y + 120);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await isRevealed()).toBe(false);
  }, 90000);

  it('块级公式的底纹在空行上不断开', async () => {
    // 回归：底纹画在 `markdownMarkersField` 的 `Decoration.mark` 上，而跨行的 mark
    // **只会给有字符的行生成 span**——公式内部的空行一个字符都没有，于是没有底色，
    // 整条底纹被切成几段（视觉割裂）。修法是按行补一层只画底纹的行装饰。
    const source = ['# 公式', '', '$$', '', 'E = mc^2', '', '$$', '', '后段正文。'].join('\n');
    const docPath = path.join(tempDir, 'block-math-band.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await openVisual(app);

    // 含空行的写法现在也是真正的块级公式——先确认它渲染了（而不是只画底纹的源码）
    expect(await count(app, '.cm-visual-block-math:not(.cm-visual-block-math-preview)')).toBe(1);

    // 再点进编辑态：源码（含空行）露出，底纹要铺满整个范围
    await app.mouseClick('.cm-visual-block-math');
    await app.waitForSelector('.cm-visual-block-math-preview', 10000);

    const band = await app.evaluate<{
      texts: string[];
      gaps: number[];
      blankBandLeft: number | null;
      blankBarWidth: string | null;
      blankBandGradient: string | null;
      blankBarLeft: number | null;
      spanLeft: number | null;
    }>(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const banded = lines.filter((el) => el.classList.contains('cm-marker-block-math-band'));
      const blanks = banded.filter((el) => (el.textContent || '').trim() === '');
      const firstSpan = banded
        .map((el) => el.querySelector('.cm-marker-block-math'))
        .find(Boolean);
      const blankBefore = blanks.length ? getComputedStyle(blanks[0], '::before') : null;
      const blankRect = blanks.length ? blanks[0].getBoundingClientRect() : null;
      const spanRect = firstSpan ? firstSpan.getBoundingClientRect() : null;
      return {
        texts: banded.map((el) => (el.textContent || '').trim()),
        // 相邻底纹行之间的纵向缝隙（> 0 就是断开的）
        gaps: banded.slice(1).map((el, i) => {
          const prev = banded[i].getBoundingClientRect();
          const cur = el.getBoundingClientRect();
          return Math.round((cur.top - prev.bottom) * 10) / 10;
        }),
        blankBandLeft: blankRect ? blankRect.left : null,
        blankBarWidth: blankBefore ? blankBefore.width : null,
        blankBandGradient: blanks.length ? getComputedStyle(blanks[0]).backgroundImage : null,
        blankBarLeft: blankBefore ? parseFloat(blankBefore.left) : null,
        spanLeft: spanRect ? spanRect.left : null
      };
    })()`);

    // 公式范围里的**每一行**（含空行）都要有底纹
    expect(band.texts).toEqual(['$$', '', 'E = mc^2', '', '$$']);
    // 空行有底纹（行盒上的渐变）与竖条（行装饰的 ::before）
    expect(band.blankBandGradient).toContain('linear-gradient');
    expect(band.blankBandGradient).toContain(`${band.blankBarLeft}px`);
    expect(band.blankBarWidth).toBe('3px');
    // 相邻底纹行之间不能有纵向缝隙
    for (const gap of band.gaps) {
      expect(gap).toBeLessThanOrEqual(0.5);
    }
    // 竖条**只有一条**，且它的左边缘与灰块（mark span）的左边缘对齐。
    //
    // 回归：底纹原本一半来自 mark span、一半来自行盒 background，而行盒左边缘比 span
    // 靠左 6px（CodeMirror baseTheme 的 `.cm-line { padding: 0 2px 0 6px }`），
    // 于是空行上灰块比竖条多出 6px，看起来就是"竖纹没和灰块对齐"。
    // 现在底纹用渐变从同一个偏移起算、竖条也落在该偏移上。
    expect(band.blankBandLeft).not.toBeNull();
    expect(band.blankBarLeft).not.toBeNull();
    expect(band.spanLeft).not.toBeNull();
    const barLeftEdge = (band.blankBandLeft ?? 0) + (band.blankBarLeft ?? 0);
    expect(Math.abs(barLeftEdge - (band.spanLeft ?? 0))).toBeLessThanOrEqual(1);
  }, 90000);
});
