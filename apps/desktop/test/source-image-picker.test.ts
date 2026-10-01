// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  INDEXED_TEST_TIMEOUT_MS,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * 32×32 的实心 PNG。
 *
 * **不要换成 1×1**：点击走 CDP 的真实鼠标事件，坐标取元素中心后按整数派发，
 * 而 1×1 的图在 `max-width:100%` 下渲染出来就是 1px 宽 —— 中心 371.5 会落到 372，
 * 正好出界，点中的是行本身。症状是「光标被挪到范围末尾、但图片不揭示」，
 * 看起来像揭示坏了，其实是素材太小。
 */
const SOLID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANElEQVR4nO3OIQEAMAgAMDrRibRUIMsfAoGZmF9k9duYypUQEBAQEBAQEBAQEBAQEBC4DnyHeLKIDGjSfgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Source 面的图片：真机接线。
 *
 * 三层单测各自绿并不能说明这条链路接上了：
 *
 * - 投影层单测（`packages/editor/test/source-image-projection.test.ts`）直接调
 *   `buildSourceImageProjection`，**不经过宿主** —— 宿主没把文档目录喂进来时它照样绿。
 * - 行内编辑的 DOM 单测用桩 provider，**证不了真实索引里筛出来的图片**。
 * - 选项构造的 renderer 单测（`image-picker.test.ts`）只证「算出来的字符串对不对」。
 *
 * 真机这一条补的正是中间那段：`listIndexedDocuments` → 筛图片 → 算地址 →
 * 按当前地址过滤候选 → 点列表写回 → 重新渲染。
 *
 * 三条都是踩过坑才立的：
 *
 * 1. **裸文件名的嵌入按文档目录解析** —— `![[MAIN.png]]`（图在文档旁边）是真实 vault
 *    里压倒性多数的写法。曾经把它改成按工作区根解析，真实笔记的嵌入**全部变空白**，
 *    而当时的测试全绿，因为用例的图恰好都放在工作区根下。
 * 2. **揭示态图片不消失** —— 光标进范围内部时源码露出来，图片另插一份留在原位。
 *    早先是「二选一」，点一下就只剩源码。
 * 3. **候选列表按当前地址过滤** —— 它是自动补全，不是整个工作区的相册；地址清空才列全部。
 *
 * **一个文件只启动一次 Electron**（同文件第二次启动会卡在 `Runtime.enable` 不返回）。
 */
describe('Source 面图片：渲染 + 就地改地址', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-source-image-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });

    fs.writeFileSync(path.join(workspace, 'assets', 'logo.png'), SOLID_PNG);
    fs.writeFileSync(path.join(workspace, 'assets', 'second.png'), SOLID_PNG);
    // 与文档同目录的图：`![[local.png]]` 必须能找到它
    fs.writeFileSync(path.join(workspace, 'notes', 'local.png'), SOLID_PNG);
    // 非图片：出现在列表里就说明白名单漏了
    fs.writeFileSync(path.join(workspace, 'assets', 'readme.txt'), '不是图片\n', 'utf-8');

    fs.writeFileSync(
      path.join(workspace, 'notes', 'note.md'),
      '# 图床\n\n![标志](../assets/logo.png)\n',
      'utf-8'
    );
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

  /** 树上按名字点一行。按名字找而不是按顺序找：顺序取决于展开与排序，换个工作区就变了。 */
  async function openFromTree(app: ElectronAppInstance, name: string): Promise<void> {
    await app.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.nexus-tree-file'))
        .find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('树上找不到 ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`);

    const start = Date.now();
    while (Date.now() - start < 20000) {
      const current = await app.evaluate<string>(
        `document.querySelector('.nexus-filename')?.textContent ?? ''`
      );
      if (current === name) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`标题栏没有变成 ${name}`);
  }

  /** 默认就是 Source 面；已经在了就不动（多切一次会重置滚动与光标）。 */
  async function ensureSourceSurface(app: ElectronAppInstance): Promise<void> {
    const current = await app.evaluate<string | null>(
      `document.querySelector('[data-surface-kind]')?.getAttribute('data-surface-kind') ?? null`
    );
    if (current === 'source') return;
    await app.click('.nexus-surface-toggle');
    await app.waitForSelector('[data-surface-kind="source"]', 20000);
  }

  /** 按 `data-path` 点列表项。用 DOM 派发而不是按坐标点：面板是绝对定位的，坐标不稳。 */
  async function clickPickerItem(app: ElectronAppInstance, dataPath: string): Promise<void> {
    await app.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.cm-image-picker-item'))
        .find((el) => el.dataset.path === ${JSON.stringify(dataPath)});
      if (!item) {
        throw new Error('列表里没有 ' + ${JSON.stringify(dataPath)} + '，实际是 '
          + Array.from(document.querySelectorAll('.cm-image-picker-item'), (el) => el.dataset.path).join(','));
      }
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`);
  }

  /** 列表里当前有哪些候选，按顺序。 */
  const pickerPaths = (app: ElectronAppInstance) =>
    app.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.cm-image-picker-item'), (el) => el.dataset.path)`
    );

  /** 把正文里第一次出现的 `needle` 整段替换掉。地址栏就在正文里，改它就是改地址。 */
  async function replaceInSource(
    app: ElectronAppInstance,
    needle: string,
    insert: string
  ): Promise<void> {
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      const source = window.nexusSession.getSnapshot().source;
      const start = source.indexOf(${JSON.stringify(needle)});
      if (start < 0) throw new Error('正文里没有 ' + ${JSON.stringify(needle)});
      view.dispatch({
        changes: { from: start, to: start + ${JSON.stringify(needle)}.length, insert: ${JSON.stringify(insert)} }
      });
    })()`);
  }

  const sessionSource = (app: ElectronAppInstance) =>
    app.evaluate<string>(`window.nexusSession.getSnapshot().source`);

  it('Source 面渲染图片；点图后图片与源码并存，候选列表按当前地址收敛', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForIndexReady();
    await openFromTree(app, 'note.md');
    await ensureSourceSurface(app);

    /* ── ① Source 面把图片渲染出来，而且真的解码成功 ──
       `naturalWidth > 0` 才是「看得到」；只等 `complete` 的话 404 的图也算完成。 */
    await app.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );

    // 其余语法一律源码原文 —— 源码模式里冒出表格控件就等于偷开了半个 Visual 模式
    const sourceText = await app.evaluate<string>(
      `document.querySelector('.cm-content').textContent`
    );
    expect(sourceText).toContain('# 图床');
    expect(await app.evaluate(`document.querySelectorAll('.cm-visual-table').length`)).toBe(0);

    /* ── ② 点图 → 图片与源码**同时在场**，且浮出候选列表 ── */
    await app.mouseClick('.cm-visual-image');
    await app.waitForSelector('.cm-image-picker-item', 15000);

    // 揭示不等于图片消失：另插一份 alongside 留在原位，源码同时露出来
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image-alongside img'))`,
      10000
    );
    const revealed = await app.evaluate<string>(
      `Array.from(document.querySelectorAll('.cm-line'), (el) => el.textContent).join('\\n')`
    );
    expect(revealed).toContain('![标志](../assets/logo.png)');

    // 候选按**当前地址**收敛：地址写着 `../assets/logo.png`，只有它自己匹配
    expect(await pickerPaths(app)).toEqual(['../assets/logo.png']);

    /* ── ③ 改地址 → 列表跟着收敛到新前缀 ── */
    await replaceInSource(app, '../assets/logo.png', 'second.png');
    await app.waitForFunction(
      `() => {
        const paths = Array.from(document.querySelectorAll('.cm-image-picker-item'), (el) => el.dataset.path);
        return paths.length === 1 && paths[0] === '../assets/second.png';
      }`,
      10000
    );

    /* ── ④ 地址清空 → 回到「列出全部」，且非图片不进列表 ── */
    await replaceInSource(app, 'second.png', '');
    await app.waitForFunction(
      `() => document.querySelectorAll('.cm-image-picker-item').length === 3`,
      10000
    );
    const allPaths = await pickerPaths(app);
    expect(allPaths).toEqual(
      expect.arrayContaining(['../assets/logo.png', '../assets/second.png', 'local.png'])
    );
    expect(allPaths.some((entry) => entry.includes('readme'))).toBe(false);

    /* ── ⑤ 选一张：`![](…)` 按**当前文档目录**写回 ── */
    await clickPickerItem(app, '../assets/second.png');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('second.png')`,
      5000
    );
    expect(await sessionSource(app)).toBe('# 图床\n\n![标志](../assets/second.png)\n');

    // 光标离开后重新渲染，而且换的是新那张 —— 「写进去了但看不到」也算失败
    await app.evaluate(`(() => {
      const view = window.nexusActiveView;
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 0 } });
    })()`);
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image img')?.src.includes('second.png'))`,
      10000
    );

    /* ── ⑥ 裸文件名的嵌入：图与文档同目录，这是真实 vault 里压倒性多数的写法 ──
       `![[MAIN.png]]` 这类嵌入**必须**按文档所在目录解析。曾经把它改成按工作区根解析，
       结果真实笔记里的嵌入全部变空白（`<工作区根>/MAIN.png` 不存在），而测试全绿 ——
       因为那一批用例的图恰好都放在工作区根下。这一格钉的就是这个。 */
    await app.setSource('![[local.png]]\n');
    await app.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image-embed img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );

    /* ── ⑦ 嵌入档点图 → 并存 + 列表；改地址后选图，回写保住 `![[…]]` ── */
    await app.mouseClick('.cm-visual-image');
    await app.waitForSelector('.cm-image-picker-item', 15000);
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image-alongside img'))`,
      10000
    );
    expect(await pickerPaths(app)).toEqual(['local.png']);

    await replaceInSource(app, 'local.png', 'second.png');
    await app.waitForFunction(
      `() => {
        const paths = Array.from(document.querySelectorAll('.cm-image-picker-item'), (el) => el.dataset.path);
        return paths.length === 1 && paths[0] === '../assets/second.png';
      }`,
      10000
    );

    // 写回的是嵌入档那份地址 —— Obsidian 的**最短唯一路径**，`second.png` 全库唯一
    // 所以是裸名（带 `../assets/` 反而不符合 Obsidian 的写法），且**走 wikilink 事务** ——
    // 走 image 事务会把 `![[…]]` 改写成 `![](…)`，打开一次文件就改掉用户的源文本。
    await clickPickerItem(app, '../assets/second.png');
    await app.waitForFunction(
      `() => window.nexusSession.getSnapshot().source.includes('second.png')`,
      5000
    );
    expect(await sessionSource(app)).toBe('![[second.png]]\n');

    /* ── ⑧ 行中的图片：预览提到行首，整行源码不被劈开 ──
       预览是块级的，插在节点原位会把这一行劈成三行（图片前那截文字被挤到上一行）。
       提到行首之后源码整行完整 —— 这一格钉的就是它。 */
    await app.setSource('前文 ![[local.png]] 后文\n');
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image-embed img'))`,
      15000
    );
    await app.mouseClick('.cm-visual-image');
    await app.waitForFunction(
      `() => Boolean(document.querySelector('.cm-visual-image-alongside img'))`,
      10000
    );
    const inlineRowText = await app.evaluate<string>(`(() => {
      const preview = document.querySelector('.cm-visual-image-alongside');
      const line = preview && preview.closest('.cm-line');
      return line ? line.textContent : '';
    })()`);
    expect(inlineRowText).toBe('前文 ![[local.png]] 后文');

    /* ── ⑨ 带目录的嵌入按**工作区根相对**解析 ──
       图集中放在工作区的某个目录、嵌入直接写从根算起的完整路径，这在真实 vault 里
       和裸名一样常见。只按文档目录解析（`notes/assets/logo.png`）必然空白，
       而且连报错都没有。这一格钉的是回退链真的从宿主接到了编辑器。 */
    await app.setSource('![[assets/logo.png]]\n');
    await app.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image-embed img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );
    const rootedSrc = decodeURIComponent(
      await app.evaluate<string>(`document.querySelector('.cm-visual-image-embed img').src`)
    );
    expect(rootedSrc).toContain('/assets/logo.png');
    expect(rootedSrc).not.toContain('/notes/assets/');

    /* ── ⑩ 裸名在文档旁边找不到时，按**全库同名**兜底 ──
       `![[second.png]]` 而图在 `assets/` 下、文档在 `notes/` 下 —— 相对路径算不出来，
       只能全库按名找。Obsidian 就是这个语义。 */
    await app.setSource('![[second.png]]\n');
    await app.waitForFunction(
      `() => {
        const img = document.querySelector('.cm-visual-image-embed img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }`,
      15000
    );
    const fallbackSrc = decodeURIComponent(
      await app.evaluate<string>(`document.querySelector('.cm-visual-image-embed img').src`)
    );
    expect(fallbackSrc).toContain('/assets/second.png');
    expect(fallbackSrc).not.toContain('/notes/second.png');
  }, INDEXED_TEST_TIMEOUT_MS);
});
