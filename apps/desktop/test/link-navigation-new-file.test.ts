// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/** CDP Input.dispatchMouseEvent 的修饰键位掩码。 */
const CTRL = 2;

interface AppSnapshot {
  source: string;
  anchor: number;
  filename: string;
  hasSubtitle: boolean;
  saveStatus: string;
}

/**
 * 两个用户可见的交互承诺，用真实 Electron 守住：
 *
 * 1. 菜单里的「新建」有 Ctrl+N 快捷键，且真的能清空文档、解绑文件。
 * 2. Visual 模式下普通链接支持 Ctrl+左键跳转——外部协议走系统浏览器、相对路径由
 *    编辑器打开、`#anchor` 在文档内跳标题。链接文字本身仍是可编辑文本，所以导航
 *    必须是修饰键动作，普通点击依旧只落光标。
 *
 * 外部协议那条不做端到端断言：它会真的拉起开发机的默认浏览器，属于不可接受的测试副作用。
 * 协议白名单与 IPC 校验由主进程代码保证，`javascript:` 之类的拦截行为在这里守。
 */
describe('Ctrl+N 新建文档与 Ctrl+左键链接跳转', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  /**
   * 共享窗口：给「换内容换断言」的用例复用。
   *
   * 这批用例验的都是**链接导航的行为**（跳标题、跳相对路径、协议拦截、提示），
   * 与「打开的是哪个文件」无关 —— 换内容用 `setSource` 即可。
   *
   * **例外**：「Ctrl+点击相对链接打开另一篇文档」那条需要目标文件真实存在，
   * 用的是另一份文档（`mainPath`），所以它仍自己起窗口。
   */
  let sharedApp: ElectronAppInstance | null = null;

  beforeAll(async () => {
    tempDir = createTempDir('nexus-linknav-');

    const sharedDoc = path.join(tempDir, 'shared.md');
    fs.writeFileSync(sharedDoc, '# 占位\n', 'utf-8');

    sharedApp = await launchElectronApp({ filePath: sharedDoc });
    await sharedApp.waitForSelector('.cm-content', 20000);
  });

  afterAll(async () => {
    if (sharedApp) {
      await sharedApp.close();
      sharedApp = null;
    }
  });

  // 每条用例从干净状态开始：源码清空 + surface 回到 Source。
  // 不复位 surface 的话，上一条停在 Visual，下一条的「切到 Visual」会把它切回去。
  beforeEach(async () => {
    if (!sharedApp) return;
    await sharedApp.setSource('# 占位\n');
    await ensureSurface(sharedApp, 'source');
  });

  afterEach(async () => {
    // 只关「自己起的窗口」，共享窗口留给 afterAll
    if (activeApp && activeApp !== sharedApp) {
      await activeApp.close();
    }
    activeApp = null;
  });

  /** 确保当前 surface 是目标；已经是就不动（多切一次会改变滚动等状态）。 */
  async function ensureSurface(app: ElectronAppInstance, target: string): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === target) return;

    await app.click('.nexus-surface-toggle');
    await app.waitForSelector(`[data-surface-kind="${target}"]`, 20000);
  }

  async function snapshot(app: ElectronAppInstance): Promise<AppSnapshot> {
    return app.evaluate<AppSnapshot>(`(() => {
      const session = window.nexusSession;
      const snap = session ? session.getSnapshot() : null;
      return {
        source: snap ? snap.source : '',
        anchor: snap ? snap.selection.anchor : -1,
        filename: document.querySelector('.nexus-filename')?.textContent ?? '',
        hasSubtitle: Boolean(document.querySelector('.nexus-filepath-subtitle')),
        saveStatus: document.querySelector('.status-text')?.textContent ?? ''
      };
    })()`);
  }

  async function openInVisualMode(app: ElectronAppInstance): Promise<void> {
    await ensureSurface(app, 'visual');
  }

  it('clears the document on Ctrl+N and drops the file binding', async () => {
    // 这条用独立窗口：它会**解绑文件**（那正是被测行为），而共享窗口的后续用例
    // 要断言文件名 —— 状态恢复不回来，setSource 只换内容、不会重新绑定文件。
    const docPath = path.join(tempDir, 'ctrl-n.md');
    fs.writeFileSync(docPath, '# Ctrl N 起点\n\n有内容。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    const before = await snapshot(app);
    expect(before.source).toContain('Ctrl N 起点');
    expect(before.hasSubtitle).toBe(true);

    await app.pressKey('n', { ctrl: true });
    await app.waitForFunction(
      `() => window.nexusSession && window.nexusSession.getSnapshot().source === ''`
    );

    const after = await snapshot(app);
    expect(after.source).toBe('');
    expect(after.filename).toContain('Untitled.md');
    // 文件路径副标题消失 = filePath 已置空，不会再把空文档写回原文件
    expect(after.hasSubtitle).toBe(false);
    // 保存状态现在只由状态栏展示：新建的空文档不该被报成"有未保存改动"
    expect(after.saveStatus).not.toBe('Unsaved');
  }, 90000);

  it('jumps to the target heading on Ctrl+click of an anchor link', async () => {
    const source = [
      '# 目录',
      '',
      '- [跳到目标](#目标小节)',
      '',
      '## 目标小节',
      '',
      '正文。'
    ].join('\n');
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    const expected = source.indexOf('## 目标小节');
    // 先把光标挪到别处，确保后面的位移确实来自跳转而不是初始状态
    await app.evaluate(`(() => {
      window.nexusActiveView.dispatch({ selection: { anchor: 0 } });
      return true;
    })()`);

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().selection.anchor === ${expected}`
    );

    const after = await snapshot(app);
    expect(after.anchor).toBe(expected);
    // 跳转是纯读操作，不许改动 canonical source
    expect(after.source).toBe(source);
  }, 90000);

  interface ScrollProbe {
    /** 目标行相对滚动容器顶边的偏移；目标行未渲染（虚拟化）时为 null。 */
    targetOffsetFromTop: number | null;
    /** 目标行对应的行号 gutter 元素顶边；拿不到时为 null。 */
    targetGutterTop: number | null;
    targetGutterText: string | null;
    /** 视口里第一条**完整可见**的文本行——需求就是"目标行是这一条"。 */
    topmostFullyVisibleText: string | null;
    scrollerHeight: number;
  }

  async function probeScroll(app: ElectronAppInstance, text: string): Promise<ScrollProbe> {
    return app.evaluate<ScrollProbe>(`(() => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) {
        return { targetOffsetFromTop: null, targetGutterTop: null, targetGutterText: null,
                 topmostFullyVisibleText: null, scrollerHeight: 0 };
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const target = lines.find((el) => (el.textContent || '').includes(${JSON.stringify(text)}));

      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - scrollerRect.top, bottom: r.bottom - scrollerRect.top };
      };

      // "完整可见"= 行盒顶边没有越过视口顶边。这正是用户要的"第一行"——
      // 若按"下缘还在视口内"来判，被裁掉的那一行也会算进来，测不出行号被裁的问题。
      const topmost = lines
        .map((el) => ({ text: (el.textContent || '').trim(), ...rectOf(el) }))
        .filter((l) => l.top >= -0.5 && l.text.length > 0)
        .sort((a, b) => a.top - b.top)[0] ?? null;

      // 行号 gutter 元素按行绝对定位，与 .cm-line 一一对应；按几何就近匹配，
      // 比按 DOM 下标对齐更稳（gutter 里可能有额外占位元素）。
      let gutter = null;
      if (target) {
        const targetTop = rectOf(target).top;
        const gutters = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'));
        let best = null;
        for (const el of gutters) {
          const r = rectOf(el);
          const distance = Math.abs(r.top - targetTop);
          if (best === null || distance < best.distance) {
            best = { distance, el, top: r.top };
          }
        }
        if (best && best.distance < 1) {
          gutter = { top: best.top, text: (best.el.textContent || '').trim() };
        }
      }

      return {
        targetOffsetFromTop: target ? rectOf(target).top : null,
        targetGutterTop: gutter ? gutter.top : null,
        targetGutterText: gutter ? gutter.text : null,
        topmostFullyVisibleText: topmost ? topmost.text : null,
        scrollerHeight: scrollerRect.height
      };
    })()`);
  }

  it('scrolls the target heading to the top of the viewport, not the bottom', async () => {
    // 目标前要有足够内容（保证它一开始在视口下方 = "贴底边"问题出现的场景），
    // 目标**后**也要有超过一屏的内容——否则滚动条够不到，物理上不可能把目标顶到第一行。
    const leading = Array.from({ length: 120 }, (_, i) => `前段第 ${i + 1} 行。`).join('\n\n');
    const trailing = Array.from({ length: 80 }, (_, i) => `后段第 ${i + 1} 行。`).join('\n\n');
    const source = [
      '# 长文档',
      '',
      '- [跳到中段](#中段小节)',
      '',
      leading,
      '',
      '## 中段小节',
      '',
      '目标内容。',
      '',
      trailing
    ].join('\n');
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    const targetOffset = source.indexOf('## 中段小节');

    // 跳转前目标必须在视口下方（虚拟化下通常根本没渲染）
    const before = await probeScroll(app, '中段小节');
    expect(
      before.targetOffsetFromTop === null || before.targetOffsetFromTop > 200
    ).toBe(true);

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().selection.anchor === ${targetOffset}`
    );
    // 等滚动、渲染与补正落定
    await new Promise((resolve) => setTimeout(resolve, 800));

    const after = await probeScroll(app, '中段小节');

    // 需求本身：视口里第一条完整可见的文本行就是目标标题。
    // 退回默认的 `nearest` 策略时，目标会被丢到视口底边，这条断言立刻失败。
    expect(after.topmostFullyVisibleText).toContain('中段小节');
    expect(after.scrollerHeight).toBeGreaterThan(100);

    // 而且它确实贴在**顶部**而非底部。
    expect(after.targetOffsetFromTop ?? Number.NaN).toBeLessThan(after.scrollerHeight / 4);

    // 关键一条：目标行的**行号**必须完整可见。
    // CM 的 `y: 'start'` 只把行内文本顶边对齐到视口顶，行盒（行号就画在它顶部）
    // 会高出去一截，行号被裁掉近三分之一字高——这正是这个断言要守的东西。
    expect(after.targetGutterText).not.toBeNull();
    expect(after.targetGutterTop ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(-0.5);
  }, 90000);

  it('keeps the line number visible for every heading level', async () => {
    // 行盒比文本盒高出的差值**随标题层级变化**（实测 h1 = 8px、h2 = 6px），
    // 所以补正必须按目标行现量。写死常量的话 h2 能过、h1 会挂——这条就是拦它的。
    const leading = Array.from({ length: 120 }, (_, i) => `前段第 ${i + 1} 行。`).join('\n\n');
    const trailing = Array.from({ length: 80 }, (_, i) => `后段第 ${i + 1} 行。`).join('\n\n');
    const source = [
      '# 长文档',
      '',
      '- [跳到一级](#一级标题)',
      '',
      leading,
      '',
      '# 一级标题',
      '',
      '正文一。',
      '',
      trailing
    ].join('\n');
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    const targetOffset = source.indexOf('# 一级标题');

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().selection.anchor === ${targetOffset}`
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    const after = await probeScroll(app, '一级标题');

    expect(after.topmostFullyVisibleText).toContain('一级标题');
    expect(after.targetGutterText).not.toBeNull();
    expect(after.targetGutterTop ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(-0.5);
  }, 90000);

  it('does not overshoot when the target cannot reach the top', async () => {
    // 目标后面只有不到一屏内容 → 滚动条够不到，目标顶不到第一行。
    // 这时补正必须**收手**：行盒落在视口下方，再减就是往回退，会把最后一行切掉。
    const leading = Array.from({ length: 120 }, (_, i) => `前段第 ${i + 1} 行。`).join('\n\n');
    const source = [
      '# 长文档',
      '',
      '- [跳到末尾](#末尾小节)',
      '',
      leading,
      '',
      '## 末尾小节',
      '',
      '尾巴一。',
      '',
      '尾巴二。'
    ].join('\n');
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    const targetOffset = source.indexOf('## 末尾小节');

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().selection.anchor === ${targetOffset}`
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    const metrics = await app.evaluate<{
      scrollTop: number;
      maxScrollTop: number;
      lastLineBottom: number;
      scrollerHeight: number;
    }>(`(() => {
      const scroller = document.querySelector('.cm-scroller');
      const sr = scroller.getBoundingClientRect();
      const lines = Array.from(document.querySelectorAll('.cm-line'))
        .filter((el) => (el.textContent || '').trim().length > 0);
      const last = lines[lines.length - 1];
      return {
        scrollTop: scroller.scrollTop,
        maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
        lastLineBottom: last ? last.getBoundingClientRect().bottom - sr.top : 0,
        scrollerHeight: sr.height
      };
    })()`);

    // 已经滚到底，不许被"补正"往回退
    expect(metrics.maxScrollTop).toBeGreaterThan(0);
    expect(metrics.scrollTop).toBeGreaterThanOrEqual(metrics.maxScrollTop - 1);
    // 最后一行仍完整可见（行盒下缘没被推出视口）
    expect(metrics.lastLineBottom).toBeLessThanOrEqual(metrics.scrollerHeight + 0.5);
  }, 90000);

  it('opens the linked document on Ctrl+click of a relative link', async () => {
    const otherPath = path.join(tempDir, 'other.md');
    fs.writeFileSync(otherPath, '# 被链接的文档\n\n目标内容。\n', 'utf-8');

    const mainPath = path.join(tempDir, 'main.md');
    fs.writeFileSync(mainPath, '# 起点\n\n- [打开另一个文档](./other.md)\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: mainPath });
    const app = activeApp;
    await openInVisualMode(app);

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForFunction(
      `() => window.nexusSession && window.nexusSession.getSnapshot().source.includes('被链接的文档')`
    );

    const after = await snapshot(app);
    expect(after.filename).toContain('other.md');
    expect(after.hasSubtitle).toBe(true);
  }, 90000);

  it('ignores Ctrl+click on a blocked-protocol link', async () => {
    const source = '# 危险链接\n\n[x](javascript:alert(1))\n';
    // 断言里带着文件名（要确认打开的仍是这一篇），所以用独立窗口 ——
    // 共享窗口叫 shared.md，文件名对不上。
    const docPath = path.join(tempDir, 'blocked.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    await openInVisualMode(app);

    await app.mouseClick('.cm-visual-link-blocked', CTRL);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const after = await snapshot(app);
    expect(after.source).toBe(source);
    expect(after.filename).toContain('blocked.md');
  }, 90000);

  it('rejects non-whitelisted protocols at the main-process boundary', async () => {
    const app = sharedApp!;
    await app.setSource('# IPC 协议白名单\n');

    // 只验被拒的那一侧。白名单内的 https/mailto 会真的拉起系统程序，
    // 测试里绝不能触发——那是不可接受的副作用。
    const results = await app.evaluate<Record<string, boolean>>(`(async () => ({
      javascript: await window.nexus.openExternal('javascript:alert(1)'),
      data: await window.nexus.openExternal('data:text/html,<h1>x</h1>'),
      file: await window.nexus.openExternal('file:///C:/Windows/System32/calc.exe'),
      msdt: await window.nexus.openExternal('ms-msdt:PCWDiagnostic'),
      relative: await window.nexus.openExternal('./README.md'),
      notAUrl: await window.nexus.openExternal('not a url at all'),
      empty: await window.nexus.openExternal('')
    }))()`);

    expect(results).toEqual({
      javascript: false,
      data: false,
      file: false,
      msdt: false,
      relative: false,
      notAUrl: false,
      empty: false
    });
  }, 90000);

  it('surfaces a visible notice when the linked file does not exist', async () => {
    const source = '# 断链\n\n[缺失的文件](./does-not-exist.md)\n';
    // 同上：断言文件名，需要自己的窗口
    const docPath = path.join(tempDir, 'missing-link.md');
    fs.writeFileSync(docPath, source, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    await openInVisualMode(app);

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForSelector('.nexus-banner-dismiss-btn', 10000);

    const banner = await app.getText('.nexus-warning-banner');
    expect(banner).toContain('does-not-exist.md');

    // 跳转失败不能把当前文档换掉或改坏
    const after = await snapshot(app);
    expect(after.filename).toContain('missing-link.md');
    expect(after.source).toBe(source);

    await app.click('.nexus-banner-dismiss-btn');
    const stillThere = await app.evaluate<boolean>(
      `Boolean(document.querySelector('.nexus-banner-dismiss-btn'))`
    );
    expect(stillThere).toBe(false);
  }, 90000);

  it('surfaces a visible notice when an anchor matches no heading', async () => {
    const source = '# 标题\n\n[跳到不存在的地方](#nope)\n';
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    await app.mouseClick('.cm-visual-link', CTRL);
    await app.waitForSelector('.nexus-banner-dismiss-btn', 10000);

    // 文案本身由 banner-i18n.test.ts 负责（它按语言逐字比对）。
    // 这里只锁这条用例自己的不变量：提示可见、点名了那个锚点、没退化成未解析的词典键。
    // 原先断言的是硬编码中文「找不到锚点」，等于把「文案写死在组件里」当成契约。
    const banner = await app.getText('.nexus-warning-banner');
    expect(banner).toContain('#nope');
    expect(banner).not.toContain('link.error.unresolvedAnchor');

    const after = await snapshot(app);
    expect(after.source).toBe(source);
  }, 90000);

  it('keeps the link text editable on a plain click in Visual mode', async () => {
    const source = '# 普通点击\n\n[可编辑文字](https://example.com)\n';
    const app = sharedApp!;
    await app.setSource(source);
    await openInVisualMode(app);

    await app.mouseClick('.cm-visual-link');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 普通点击不导航：没有打开任何外部目标，光标落在链接文字里
    const state = await app.evaluate<{ anchor: number; source: string }>(`(() => {
      const snap = window.nexusSession.getSnapshot();
      return { anchor: snap.selection.anchor, source: snap.source };
    })()`);
    const textStart = source.indexOf('可编辑文字');
    expect(state.anchor).toBeGreaterThanOrEqual(textStart);
    expect(state.anchor).toBeLessThanOrEqual(textStart + '可编辑文字'.length);
    expect(state.source).toBe(source);
  }, 90000);
});
