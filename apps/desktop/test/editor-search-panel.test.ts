// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  ensureSurface,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 编辑器内的查找 / 替换面板。
 *
 * 面板是**自绘**的（`search({ createPanel })`，源码在
 * `packages/editor/src/search-panel.ts`），DOM 契约与内置面板完全不同 ——
 * 选择器一律走 `.nexus-find`，输入框认 `input` 事件而不是 `keyup`/`change`。
 *
 * 四件只有真机能证的事：
 *
 * 1. **面板是右上角的悬浮卡片，不占文档流、也不压住滚动条。** CM 的 `.cm-panels` 默认是
 *    `position: sticky`（横贯一条、把正文往下挤）；我们把它改成 absolute，并让卡片右侧
 *    退开滚动条占的那几像素。这两条改动 happy-dom 都证不了（它不算 CSS），只能在这里量
 *    `.cm-content` 的顶边、以及卡片与滚动条的相对位置。
 * 2. **面板上的字跟随界面语言。** 自绘面板每次 `update()` 都重读 `state.phrase()`，
 *    所以是**当场**换的 —— 不必像内置面板那样关掉重开。这里就按「当场」断言，
 *    顺带钉住「重开之后文案也对」（面板实例每次新建）。
 * 3. **查找与替换是两个入口。** 两条命令各带各的快捷键，`Mod-h` 要把焦点放在
 *    替换框、并展开替换行。
 * 4. **默认语言写死是 en-US**（`LocaleManager` 不吃系统语言），所以英文那半也
 *    一并断言 —— 哪天默认变了，这条会先知道。
 */
describe('编辑器查找 / 替换面板', () => {
  const tempDir = createTempDir('nexus-editor-search-');
  let activeApp: ElectronAppInstance | null = null;

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  /** 面板输入框的 placeholder（文案就是从这里读出来的）。 */
  const placeholder = (app: ElectronAppInstance, name: string) =>
    app.evaluate<string>(
      `document.querySelector('.nexus-find input[name="${name}"]')?.getAttribute('placeholder') ?? ''`
    );

  /** 面板元素的 aria-label。图标按钮没有文字，含义全在这里。 */
  const label = (app: ElectronAppInstance, name: string) =>
    app.evaluate<string>(
      `document.querySelector('.nexus-find [name="${name}"]')?.getAttribute('aria-label') ?? ''`
    );

  /** 面板元素上的文字。 */
  const text = (app: ElectronAppInstance, name: string) =>
    app.evaluate<string>(`document.querySelector('.nexus-find [name="${name}"]')?.textContent ?? ''`);

  /** 当前焦点落在哪个输入框上。 */
  const focusedField = (app: ElectronAppInstance) =>
    app.evaluate<string>(`document.activeElement?.getAttribute('name') ?? ''`);

  const closePanel = (app: ElectronAppInstance) =>
    app.evaluate(
      `(() => { document.querySelector('.nexus-find button[name=close]')?.click(); return true; })()`
    );

  const waitPanelClosed = (app: ElectronAppInstance) =>
    app.waitForFunction(`!document.querySelector('.nexus-find')`, 10000);

  /** 面板的自绘输入框认 `input` 事件（内置面板认 `keyup` / `change`，这里不一样）。 */
  const setQuery = async (app: ElectronAppInstance, query: string) => {
    await app.evaluate(`(() => {
      const input = document.querySelector('.nexus-find input[name=search]');
      if (!input) throw new Error('查找面板不在');
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // commit 走 dispatch，等 decoration 与计数器都重算完
    await new Promise((r) => setTimeout(r, 400));
  };

  /** 计数器的文本（面板里我们自己建的那个 span，`.nexus-find-count`）。 */
  const countText = (app: ElectronAppInstance) =>
    app.evaluate<string>(`document.querySelector('.nexus-find-count')?.textContent ?? ''`);

  const switchLocale = async (app: ElectronAppInstance, locale: string) => {
    await app.evaluate(`window.nexusLocale.setLocale('${locale}')`);
    await app.waitForFunction(`window.nexusLocale.locale === '${locale}'`, 5000);
  };

  it('面板是编辑器右上角的悬浮卡片，不把正文往下挤', async () => {
    const docPath = path.join(tempDir, 'floating.md');
    // 要**够长**：这份 fixture 必须让编辑器出现滚动条，否则「让开滚动条」那两条断言
    // 是空的（`gutter` 量到 0，怎么放都「不压」）。
    const lines = ['# 标题', '', '正文第一行。', '正文第二行。'];
    for (let i = 0; i < 160; i += 1) lines.push(`第 ${i + 1} 段填充文字，用来把编辑器撑出滚动条。`);
    fs.writeFileSync(docPath, `${lines.join('\n')}\n`, 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    const contentTop = () =>
      app.evaluate<number>(`document.querySelector('.cm-content').getBoundingClientRect().top`);

    const before = await contentTop();
    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find', 10000);
    await new Promise((r) => setTimeout(r, 300));
    const after = await contentTop();

    // ① 正文一动不动。CM 的 `.cm-panels` 默认是 `position: sticky`（**占流**），
    //    改成 absolute 才不占 —— 这条就是那个改动的判据，也是用户报的那个毛病
    //    （「搜索框应该像 VS Code 那样浮在右上角」）。
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);

    // ② 卡片贴在编辑器右上角，并且**让开了滚动条**。
    const box = await app.evaluate<{
      top: number;
      right: number;
      width: number;
      gutter: number;
      clearsScrollbar: boolean;
    }>(`
      (() => {
        const card = document.querySelector('.nexus-find').getBoundingClientRect();
        const editor = document.querySelector('.cm-editor').getBoundingClientRect();
        const scroller = document.querySelector('.cm-scroller');
        const scrollerRect = scroller.getBoundingClientRect();
        const gutter = scroller.offsetWidth - scroller.clientWidth;
        return {
          top: Math.round(card.top - editor.top),
          right: Math.round(editor.right - card.right),
          width: Math.round(card.width),
          gutter,
          // 滚动条占 [scrollerRect.right - gutter, scrollerRect.right]，卡片必须整个在它左边。
          clearsScrollbar: card.right <= scrollerRect.right - gutter
        };
      })()
    `);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeLessThan(24);
    expect(box.width).toBeGreaterThan(280);
    expect(box.width).toBeLessThanOrEqual(420);
    // 卡片右边缘要比「滚动条右边缘」往左退至少 4px。`gutter` 是现量的滚动条宽度
    // （覆盖层滚动条的平台量到 0，那时这条退化成「别贴边」）—— 阿战报的
    // 「搜索框靠右、压住滚动条」就是这条判据。
    expect(box.right).toBeGreaterThanOrEqual(box.gutter + 4);
    expect(box.clearsScrollbar).toBe(true);

    // ③ 容器横向铺满编辑器，所以它必须对指针透明 —— 否则顶部会多出一条点不动的死区。
    //    这两条只能真机验（happy-dom 不算 CSS）。
    const pointer = await app.evaluate<{ container: string; card: string }>(`
      (() => ({
        container: getComputedStyle(document.querySelector('.cm-panels-top')).pointerEvents,
        card: getComputedStyle(document.querySelector('.nexus-find')).pointerEvents
      }))()
    `);
    expect(pointer.container).toBe('none');
    expect(pointer.card).toBe('auto');

    // ④ 死区的行为面判据：卡片**左侧**那条带上取一个点，命中的不能是面板容器。
    const hitIsPanel = await app.evaluate<boolean>(`
      (() => {
        const editor = document.querySelector('.cm-editor').getBoundingClientRect();
        const el = document.elementFromPoint(editor.left + 16, editor.top + 20);
        return !!el && !!el.closest('.cm-panels');
      })()
    `);
    expect(hitIsPanel).toBe(false);
  }, 90000);

  it('面板文案跟随语言（当场换），查找与替换是两个入口', async () => {
    const docPath = path.join(tempDir, 'doc.md');
    fs.writeFileSync(docPath, '# 标题\n\n正文里有「锚点」二字。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);

    // ① 默认语言（en-US）：面板是英文，Mod-f 的焦点在查找框
    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find', 10000);
    expect(await placeholder(app, 'search')).toBe('Find');
    expect(await label(app, 'next')).toBe('Next');
    expect(await label(app, 'close')).toBe('Close search panel');
    expect(await focusedField(app)).toBe('search');

    // ② 换成中文 —— **面板不用关重开**：自绘面板每次 update 都重读 state.phrase()。
    //    （内置面板做不到这点，它的文案全在构造函数里读，这是自绘顺带修掉的一处。）
    await switchLocale(app, 'zh-CN');
    await app.waitForFunction(
      `document.querySelector('.nexus-find input[name=search]')?.placeholder === '查找'`,
      10000
    );
    expect(await label(app, 'next')).toBe('下一个');
    expect(await label(app, 'close')).toBe('关闭查找面板');
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-find')?.getAttribute('aria-label') ?? ''`)
    ).toBe('查找和替换');
    expect(await focusedField(app)).toBe('search');

    // ③ 关掉重开：面板实例是新建的，文案照样对（查询也该留着）。
    await closePanel(app);
    await waitPanelClosed(app);
    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find', 10000);
    expect(await placeholder(app, 'search')).toBe('查找');
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-find')?.dataset.replace ?? ''`)
    ).toBe('closed');

    // ④ Mod-h 是替换入口：同一个面板，替换行展开、焦点落在替换框
    await closePanel(app);
    await waitPanelClosed(app);

    await app.dispatchKey('h', { ctrl: true });
    await app.waitForSelector('.nexus-find input[name=replace]', 10000);
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-find')?.dataset.replace ?? ''`)
    ).toBe('open');
    expect(await focusedField(app)).toBe('replace');
    expect(await placeholder(app, 'replace')).toBe('替换为');
    expect(await text(app, 'replace-all')).toBe('全部替换');
  }, 90000);

  it('匹配计数：中文环境跟随查询与跳转，空结果给「无结果」', async () => {
    const docPath = path.join(tempDir, 'count.md');
    // 两处「锚点」：计数至少要有分母
    fs.writeFileSync(docPath, '# 标题\n\n正文里有「锚点」二字，末句再来一处锚点。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    // 中文环境（默认是 en-US，先切）
    await switchLocale(app, 'zh-CN');

    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find input[name=search]', 10000);

    // ① 两处命中：显示「当前/总数」，初始光标在第一处之前 → 1/2
    await setQuery(app, '锚点');
    expect(await countText(app)).toBe('1/2');

    // ② 点「下一个」：第一次落在第一处（光标初始在 0，findNext 从光标之后找），
    //    第二次才到第二处 —— 计数跟着走。这个「第一次不算前进」与 CM 的
    //    findNext 语义一致，也是单测里钉过的同一条行为。
    await app.evaluate(`document.querySelector('.nexus-find button[name=next]')?.click()`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await countText(app)).toBe('1/2');
    await app.evaluate(`document.querySelector('.nexus-find button[name=next]')?.click()`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await countText(app)).toBe('2/2');

    // ③ 零匹配：给「无结果」，并且整张卡片打上 `data-state=none`（CSS 用它换警示色）、
    //    跳转按钮禁用。面板不挡正文，用户不会自己发现「一处都没高亮」——这是唯一反馈。
    await setQuery(app, '不存在的词');
    expect(await countText(app)).toBe('无结果');
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-find')?.dataset.state ?? ''`)
    ).toBe('none');
    expect(
      await app.evaluate<boolean>(`document.querySelector('.nexus-find button[name=next]')?.disabled ?? false`)
    ).toBe(true);

    // ④ 清空查询：显示 `0/0`（而不是隐藏）—— 数字变化时位置不跳。
    await setQuery(app, '');
    expect(await countText(app)).toBe('0/0');

    // ⑤ 换成英文：计数器的文案当场跟着语言走
    await switchLocale(app, 'en-US');
    await setQuery(app, '不存在的词');
    expect(await countText(app)).toBe('No results');
  }, 90000);

  /**
   * P0-2：视觉面里被 widget 整块换掉的文本「搜得到但看不见」。
   *
   * 机制是 CM 的一条事实：搜索高亮是给匹配 range 打 `searchMatch` **mark**，
   * 而 mark 落在 `Decoration.replace` 的 range 上时 DOM 里**不出现那个 class**。
   * 视觉面的 wikilink 整段就是 `Decoration.replace(widget)` —— 于是用户搜
   * `[[…]]` 里的字，面板说「1/1」，正文里却一处高亮都没有。
   *
   * 补法是让 widget 自己知道「我身上有命中」（`searchHitRangesField` → widget 的
   * `searchHit` 身份 → `.cm-search-hit-shadow`）。这条链的前半截（field 的内容）
   * 在 `packages/editor/test/search-panel.test.ts` 里单测；这里证后半截：真 DOM 上
   * 那个 class 真的出现了，而且面板一关就撤掉。
   */
  it('视觉面：被 widget 换掉的 wikilink 由 widget 自己补命中底色', async () => {
    const docPath = path.join(tempDir, 'wikilink-search.md');
    // 查询词就是 wikilink 的**内容** —— 整段在视觉面被替换成 widget。
    fs.writeFileSync(docPath, '# 索引\n\n参见 [[wiki锚点目标]] 那一篇。\n', 'utf-8');

    activeApp = await launchElectronApp({ filePath: docPath });
    const app = activeApp;
    await app.waitForSelector('.cm-content', 20000);
    await ensureSurface(app, 'visual');
    await app.waitForSelector('.cm-visual-wikilink', 15000);

    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find input[name=search]', 10000);
    await setQuery(app, 'wiki锚点目标');

    // ① 视觉面：CM 自己的高亮**一处都落不下来**（这段文本整个被 widget 替换了），
    //    改由 widget 自己带上命中底色。两行合起来才是完整的症状描述：
    //    「0 处高亮」不是「没搜到」，而是「搜到了、高亮没地方画」。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-searchMatch').length`)
    ).toBe(0);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.cm-visual-wikilink.cm-search-hit-shadow').length`
      )
    ).toBe(1);

    // ② 关掉面板底色跟着消失。这条挡的是「命中态挂在 widget 上再也撤不掉」——
    //    field 清空后 widget 的身份变了，投影重算出不带底色的那一个。
    //    （widget 的 `eq()` 必须含 `searchHit`，否则 CM 会复用旧 DOM、画面不动。）
    await closePanel(app);
    await waitPanelClosed(app);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.cm-visual-wikilink.cm-search-hit-shadow').length`
      )
    ).toBe(0);

    // ③ 源码面同一处查询看得见 —— 那边 wikilink 就是纯文本，CM 自己的 mark 够用。
    //    两面合起来才是「搜到了、也看得见」；只测视觉面会漏掉「别把源码面也一起
    //    改了」这类回归。
    await ensureSurface(app, 'source');
    await app.dispatchKey('f', { ctrl: true });
    await app.waitForSelector('.nexus-find input[name=search]', 10000);
    await setQuery(app, 'wiki锚点目标');
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-searchMatch').length`)
    ).toBe(1);
    expect(
      await app.evaluate<number>(`document.querySelectorAll('.cm-search-hit-shadow').length`)
    ).toBe(0);
  }, 90000);
});
