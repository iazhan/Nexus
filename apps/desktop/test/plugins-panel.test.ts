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

/** 内置能力的完整名单。**顺序无关**：清单的顺序由注册表决定，这里只比对集合。 */
const BUILTIN_IDS = ['nexus-math', 'nexus-mermaid', 'image', 'pdf', 'docx'];

/** 某一行上写的状态。取 `data-plugin-status`，不靠类名拼接猜。 */
const pluginStatus = (app: ElectronAppInstance, id: string) =>
  app.evaluate<string | null>(
    `document.querySelector('[data-plugin-id="${id}"]')?.dataset.pluginStatus ?? null`
  );

/** 按名字点文件树里的一项。用 DOM 派发：面板可能是 `display:none`，按坐标点不到。 */
const openFileByName = (app: ElectronAppInstance, name: string) =>
  app.evaluate<boolean>(`(() => {
    const files = Array.from(document.querySelectorAll('.nexus-tree-file'));
    const target = files.find((el) => el.querySelector('.nexus-tree-name')?.textContent === ${JSON.stringify(name)});
    if (!target) return false;
    target.click();
    return true;
  })()`);

/**
 * 插件面板。
 *
 * 它显示的重点是 `idle`（已登记但文档里从没出现过触发语法 / 没打开过该类型附件，
 * 包一个字节都没下载）与 `loaded` 的对比 —— 这是「按内容懒加载」在 UI 上的证据。
 *
 * 另一条同等重要的判据是**报数正确**：面板此前只列 `ExtensionHost` 里的两个扩展，
 * 而实际有五个能力（两个编辑器扩展 + 三个附件渲染器）—— 用户以为 Nexus 只有两个能力。
 * 所以这里断言的是**完整名单**，不是「包含 math 与 mermaid」：后者对「漏掉渲染器」同样成立。
 *
 * 第三条是**自刷新**：注册表的状态是在用户看不见的时候变的（投影挂载、打开附件），
 * 面板必须靠订阅自己醒过来。它单独用一份带公式的工作区验，理由见那条用例。
 *
 * 状态推导本身的单测在 `renderer/test/capability-manifest.test.ts`，
 * 订阅的单测在 `renderer/test/plugins-panel.test.tsx`，
 * 扩展那侧的 7 条在 `packages/editor/test/extension-status.test.ts`。
 */
describe('插件面板', () => {
  let tempDir: string;
  let workspace: string;
  let mathWorkspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-plugins-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    // 刻意只放纯文本：公式与 mermaid 两个扩展都不该被触发，
    // 图片 / PDF / DOCX 三个渲染器也都不该被打开
    fs.writeFileSync(path.join(workspace, 'plain.md'), '# 纯文本\n\n没有公式也没有图表。\n', 'utf-8');

    // 第二个工作区，只给「自刷新」那条用例。不复用上面那个 ——
    // 那条用例的前提正是「工作区里一个触发语法都没有」，加一个 .md 就把它改掉了。
    mathWorkspace = path.join(tempDir, 'math-vault');
    fs.mkdirSync(mathWorkspace, { recursive: true });
    fs.writeFileSync(path.join(mathWorkspace, 'formula.md'), '# 公式\n\n行内 $E = mc^2$。\n', 'utf-8');
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

  it('列出全部内置能力，纯文本文档下都停留在未加载', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;
    await app.waitForSelector('.nexus-activity-bar', 20000);

    await app.click('.nexus-activity-icon[data-activity="extensions"]');
    await app.waitForSelector('.nexus-plugin-row', 10000);

    const rows = await app.evaluate<
      Array<{ id: string; kind: string; status: string; name: string }>
    >(
      `Array.from(document.querySelectorAll('.nexus-plugin-row')).map((el) => ({
         id: el.dataset.pluginId,
         kind: el.dataset.pluginKind,
         status: el.dataset.pluginStatus,
         name: el.querySelector('.nexus-plugin-name').textContent
       }))`
    );

    expect(rows.map((row) => row.id).sort()).toEqual([...BUILTIN_IDS].sort());
    expect(rows.filter((row) => row.kind === 'editor-extension')).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'viewer')).toHaveLength(3);

    // 可读名称：`nexus-math` 是标识符不是名字。断言「不等于 id」而不是比对具体文案，
    // 这样换语言、改文案都不会误伤；裸 id 仍留在行的 `title` 上供排查。
    for (const row of rows) {
      expect(row.name).toBeTruthy();
      expect(row.name).not.toBe(row.id);
    }

    // 纯文本文档：**每一条**都停留在「未加载」—— 两个扩展没被触发，三个渲染器没打开过。
    // 只断言 math / mermaid 是 idle 是不够的，那样「漏掉了渲染器」会再次逃过测试。
    expect(rows.map((row) => row.status)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-plugin-state-loading, .nexus-plugin-state-loaded, .nexus-plugin-state-failed').length`
      )
    ).toBe(0);

    // 计数徽章与行数一致（选择器限定在面板内：其它侧栏面板也用了同一个类名）
    expect(
      await app.evaluate<string>(`document.querySelector('.nexus-plugins .nexus-sidebar-count').textContent`)
    ).toBe(String(BUILTIN_IDS.length));
  }, 45000);

  /**
   * 自刷新：**中间不再碰面板，也不发生任何编辑**。
   *
   * 这条守的是「状态从哪来」。面板读的是两个注册表的**拉**接口，而扩展包是在
   * 投影挂载那条路上加载完的 —— 用户看不见。此前面板借 `documentRevision`（文档内容
   * 版本号）当刷新信号，于是「加载完成」到「下一次编辑」之间它会一直停在旧状态；
   * 打开一份 PDF、什么都不做，面板就永远显示「加载中」。
   *
   * 所以这里刻意**不**在加载后触发任何编辑：面板必须靠注册表的通知自己醒过来。
   * 反向验证：把 `PluginsPanel` 里那个 `useSyncExternalStore` 去掉，这条会超时。
   */
  it('打开带公式的文档后，面板自己从 idle 变 loaded —— 不需要任何编辑', async () => {
    activeApp = await launchElectronApp({ filePath: mathWorkspace });
    const app = activeApp;
    await app.waitForIndexReady();

    // 先打开面板：此刻一个文档都没打开，公式扩展是 idle
    await app.click('.nexus-activity-icon[data-activity="extensions"]');
    await app.waitForSelector('.nexus-plugin-row', 10000);
    expect(await pluginStatus(app, 'nexus-math')).toBe('idle');

    // 打开带公式的文档。Source 面不挂 widget，所以这一步本身不触发加载。
    expect(await openFileByName(app, 'formula.md')).toBe(true);
    await app.waitForSelector('.cm-content', 20000);
    await app.click('[data-action="toggle-surface"]');
    await app.waitForSelector('[data-surface-kind="visual"]', 20000);
    // 行内公式的 widget（块级的是 `.cm-visual-block-math`，两者类名不同）
    await app.waitForSelector('.cm-visual-inline-math', 20000);
    // 公式真的渲染出来才说明扩展加载**完成**了，而不只是开始了
    await app.waitForSelector('.katex', 20000);

    // **关键**：这中间没有再碰过面板。超时即「面板没自己醒过来」。
    await app.waitForFunction(
      `() => document.querySelector('[data-plugin-id="nexus-math"]')?.dataset.pluginStatus === 'loaded'`,
      15000
    );

    // 反面：另一条不能跟着一起变成 loaded —— 否则「全都标成已加载」也能过
    expect(await pluginStatus(app, 'nexus-mermaid')).toBe('idle');
  }, INDEXED_TEST_TIMEOUT_MS);
});
