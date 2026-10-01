// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  launchElectronApp,
  createTempDir,
  MAIN_WINDOW_URL_MARKER,
  SETTINGS_WINDOW_URL_MARKER,
  type ElectronAppInstance
} from './smoke-harness.js';
import { indexPathForWorkspace } from '../electron/index-path.js';

/**
 * `apps/desktop/package.json` 里的版本 —— 也就是 `app.getVersion()` 在**未打包**运行时
 * 会读到的那个。用它当期望值而不是「非空」：后者对一个写死的字符串也过。
 */
const EXPECTED_APP_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'),
      'utf-8'
    )
  ) as { version: string }
).version;

/**
 * 设置窗口的真机接线。
 *
 * 三件事只有真机能证：
 *
 * 1. **窗口真的被建出来**（不是主窗口里换了个视图）—— 主窗口里不再有 `.nexus-settings-view`，
 *    设置界面在**另一个 CDP page target** 上。
 * 2. **单例** —— 重复触发不会开出第二个设置窗口。
 * 3. **跨窗口同步** —— 设置窗口改了主题，主窗口的 `data-theme` 跟着变。
 *
 * renderer 层的分支（七组空态 / 键盘 / Escape 的两个分支）在
 * `renderer/test/{settings-view,settings-window}.test.tsx` 里。
 *
 * **一个文件只启动一次 Electron** —— 同文件第二次启动会卡在 `Runtime.enable` 不返回
 * （见 `.workbuddy-ai/memory/MEMORY.md`）。所以整条交互链塞进同一个用例。
 */
describe('设置窗口', () => {
  let tempDir: string;
  let workspace: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-settings-window-');
    workspace = path.join(tempDir, 'vault');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.md'), '# A\n\n正文。\n', 'utf-8');
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

  it('快捷键开窗、结构齐备、主题跨窗口同步、单例、Escape 关窗、关掉后能再开', async () => {
    activeApp = await launchElectronApp({ filePath: workspace });
    const app = activeApp;

    await app.waitForSelector('.nexus-activity-bar', 20000);

    // ① 起初只有一个窗口，主窗口里**没有**设置界面
    expect((await app.pageTargets()).length).toBe(1);
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(
      false
    );

    // ② `Mod-,` 开出**第二个窗口**
    //    用 `dispatchKey`（DOM 派发）而不是 `pressKey`：后者走 CDP 输入管线、依赖窗口真实
    //    持有系统焦点，无头运行下不可靠。详见 harness 的 `dispatchKey` 注释。
    await app.dispatchKey(',', { ctrl: true });
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);
    expect((await app.pageTargets()).length).toBe(2);
    // 主窗口不受影响：活动栏还在，设置界面没有挤进主窗口
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-activity-bar')`)).toBe(
      true
    );
    expect(await app.evaluate<boolean>(`!!document.querySelector('.nexus-settings-view')`)).toBe(
      false
    );

    // ③ 切到设置窗口：它自己是一页，装的是设置本体
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-settings-view', 15000);
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-window-role="settings"]') !== null`
      )
    ).toBe(true);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-settings-nav [data-section]')).map((el) => el.getAttribute('data-section'))`
      )
    ).toEqual([
      'general',
      'editor',
      'files',
      'appearance',
      'keybindings',
      'plugins',
      'sync',
      'data'
    ]);
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-settings-nav [data-availability="planned"]').length`
      )
    ).toBe(2);
    // 数据分组这一批转可用：里面是两个动作（重建索引 / 打开历史目录）。
    // 文件与链接分组随「粘贴图片落盘」转可用（附件存放位置 / 子目录名 / 命名模板），
    // 后又加了「新建文档默认位置」。
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('.nexus-settings-nav [data-availability="available"]')).map((el) => el.getAttribute('data-section'))`
      )
    ).toEqual(['general', 'editor', 'files', 'appearance', 'keybindings', 'data']);
    // 独立窗口没有「返回工作区」这个键了 —— 关窗归标题栏与 Escape
    expect(await app.evaluate<boolean>(`!!document.querySelector('[data-settings-back]')`)).toBe(
      false
    );

    // ④ 在设置窗口改**模式**：`data-theme` 立刻变，存档写的是 `<预设>@<模式>`
    const resolved = await app.evaluate<string>(`document.documentElement.dataset.theme ?? ''`);
    const target = resolved === 'nexus-dark' ? 'nexus-light' : 'nexus-dark';
    const mode = target === 'nexus-dark' ? 'dark' : 'light';
    await app.click(`[data-theme-mode="${mode}"]`);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === ${JSON.stringify(target)}`,
      10000
    );
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-theme') ?? ''`)).toBe(
      `nexus@${mode}`
    );

    // ④b 换**预设**：主题 id 整个换掉，而模式轴不动。
    //     出厂预设现在恒为明暗两版齐全，所以结果跟着上一步选定的模式走 —— 用 `${mode}` 拼。
    await app.click('[data-theme-option="gruvbox"]');
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === 'gruvbox-${mode}'`,
      10000
    );
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-theme') ?? ''`)).toBe(
      `gruvbox@${mode}`
    );

    // ④c 排版设置走**同一条**跨窗口链路。判据取 `documentElement` 上的 CSS 变量而不是输入框的值
    //     —— 变量才是编辑器真正读的东西，输入框只证明控件写进了 store。
    //     数字输入框没有原生 `change` 语义，要走 React 认的那条路：原生 setter + `input` 事件。
    await app.click('.nexus-settings-nav [data-section="editor"]');
    await app.waitForSelector('[data-field-input="editor.fontSize"]', 10000);
    await app.evaluate(`(() => {
      const input = document.querySelector('[data-field-input="editor.fontSize"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '18');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-editor-font-size') ?? ''`)).toBe(
      '18'
    );
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-font-size')`
      )
    ).toBe('18px');

    // ④c′ 开关型的外观项走同一条链。行号没有 DOM 落点（数字是 `::before` 画的），
    //     所以只能断言变量 —— 变量变了编辑器那边就一定变，渲染由 CSS 保证。
    //     先读当前存档再点，不假定初始值是「开」：user-data-dir 不按用例隔离。
    const lineNumbersBefore = await app.evaluate<string>(
      `localStorage.getItem('nexus-editor-code-block-line-numbers') ?? 'true'`
    );
    const expectedLineNumberVar = lineNumbersBefore === 'true' ? 'none' : 'inline-block';
    await app.click('[data-field-input="editor.codeBlockLineNumbers"]');
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-code-line-numbers')`
      )
    ).toBe(expectedLineNumberVar);

    // ④c″ 表格列宽同属「变量落点」那一类：`table-layout` 由主题 CSS 读。判据取变量而不是
    //     选中项 —— 变量变了表格就一定变，选中项只证明控件写进了 store。
    //     同样先读存档再改，不假定初始档位。
    const tableLayoutBefore = await app.evaluate<string>(
      `localStorage.getItem('nexus-editor-table-layout') ?? 'auto'`
    );
    const tableLayoutNext = tableLayoutBefore === 'fixed' ? 'auto' : 'fixed';
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-field-input="editor.tableLayout"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(tableLayoutNext)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-editor-table-layout') ?? ''`)).toBe(
      tableLayoutNext
    );
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-table-layout')`
      )
    ).toBe(tableLayoutNext);

    // ④c″′ 编辑器三项**默认关**的开关（打字机模式 / Vim 键位 / 拼写检查）。
    //      三项都没有 DOM 落点，所以真机里能钉的是「整条链通不通」：注册表里的 `FieldDef`
    //      → 真窗口里的 `role="switch"` → store → localStorage。行为判据在
    //      `packages/editor/test/{typewriter,vim,editor-spell-check}.test.ts`，
    //      接线（哪个 effect 把它装到视图上）在 `SourceEditor.tsx`。
    //
    //      先强制关掉再点，不假定初始值 —— 与 ④c′ 同一条理由。
    const newEditorToggles = [
      'editor.typewriterMode',
      'editor.vimKeybindings',
      'editor.spellCheck'
    ];
    await app.waitForSelector('[data-field-input="editor.spellCheck"]', 10000);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-field-input]')).map((el) => el.dataset.fieldInput).filter((id) => ${JSON.stringify(
          newEditorToggles
        )}.includes(id))`
      )
    ).toEqual(newEditorToggles);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-field-input="editor.typewriterMode"]').getAttribute('role')`
      )
    ).toBe('switch');
    // 这三项**不给重置键** —— 再点一次就回去了（与同分组的行号 / 字数一致）。
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('[data-field-reset^="editor.typewriterMode"], [data-field-reset^="editor.vimKeybindings"], [data-field-reset^="editor.spellCheck"]').length`
      )
    ).toBe(0);

    await app.evaluate(
      `(() => { window.nexusSettings.set('editor.typewriterMode', false); return true; })()`
    );
    await app.waitForFunction(
      `() => document.querySelector('[data-field-input="editor.typewriterMode"]').getAttribute('aria-checked') === 'false'`,
      10000
    );
    await app.click('[data-field-input="editor.typewriterMode"]');
    expect(
      await app.evaluate<string>(`localStorage.getItem('nexus-editor-typewriter-mode') ?? ''`)
    ).toBe('true');
    // 关回去，免得留给同一 user-data-dir 的后续步骤。
    await app.click('[data-field-input="editor.typewriterMode"]');
    expect(
      await app.evaluate<string>(`localStorage.getItem('nexus-editor-typewriter-mode') ?? ''`)
    ).toBe('false');

    // ④c‴ 开关组（`control: 'group'`）：判据属性是 `data-field-member`，与单选组的
    //      `data-field-option` 同形，区别是**每个成员都画出来**。真机里要钉的是「注册表里声明
    //      的成员一个不少地画出来了」—— 少一条成员时 renderer 用例与真机用例读的是同一个
    //      `FIELDS`，会一起漏，所以这里读真实 DOM。
    await app.click('.nexus-settings-nav [data-section="appearance"]');
    await app.waitForSelector('[data-field-member="appearance.chromeVisibility:statusBar"]', 10000);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-field-member^="appearance.chromeVisibility:"]')).map((el) => el.dataset.fieldMember)`
      )
    ).toEqual(['appearance.chromeVisibility:statusBar', 'appearance.chromeVisibility:tabBar']);
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-field-member^="appearance.statusBarMetrics:"]')).map((el) => el.dataset.fieldMember)`
      )
    ).toEqual([
      'appearance.statusBarMetrics:lineColumn',
      'appearance.statusBarMetrics:selection',
      'appearance.statusBarMetrics:format'
    ]);

    // 拨一个成员：存档里出现的是**被关掉的那个**，不是「开着的那些」。
    // 先复位这一项 —— user-data-dir 不按用例隔离，上次跑剩下的隐藏项会让「点一下」的方向反过来。
    await app.evaluate(
      `(() => { window.nexusSettings.set('appearance.statusBarMetrics', ''); return true; })()`
    );
    await app.waitForFunction(
      `() => document.querySelector('[data-field-member="appearance.statusBarMetrics:format"]').getAttribute('aria-checked') === 'true'`,
      10000
    );
    await app.click('[data-field-member="appearance.statusBarMetrics:format"]');
    await app.waitForFunction(
      `() => document.querySelector('[data-field-member="appearance.statusBarMetrics:format"]').getAttribute('aria-checked') === 'false'`,
      10000
    );
    // 存档里只有被关掉的那一个 —— 存「开着的」会让空串从「全开」变成「全关」，
    // 而空串是这一组的默认值。写成精确值而不是 `toContain`：多写了别的成员就该红。
    expect(
      await app.evaluate<string>(`localStorage.getItem('nexus-status-bar-hidden') ?? ''`)
    ).toBe('format');

    // ④c⁗ 通用分组里的「启动时恢复上次工作区」。这一项**改的是下一次启动的行为**，
    //      所以它在本窗口里的可见效果就是「控件在那儿」—— 真正的效果在
    //      `restore-last-workspace.test.ts`（两次启动）里验。这里钉的是
    //      「注册表里加了它，真窗口里就真的多一个控件」，以及它是个开关而不是别的控件。
    await app.click('.nexus-settings-nav [data-section="general"]');
    await app.waitForSelector('[data-field-input="general.restoreLastWorkspace"]', 10000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-field-input="general.restoreLastWorkspace"]').getAttribute('role')`
      )
    ).toBe('switch');

    // ④c⁗′ 「当前版本」的只读值。这条要三样同时成立才过：preload 暴露了 `getAppVersion`、
    //      主进程真的从 `app.getVersion()` 读到了 `apps/desktop/package.json` 的版本、
    //      `FieldRow` 把值画出来了。renderer 用例里那个 `window.nexus` 是打桩的，
    //      证明不了前两样；而「非空」这种断言对一个写死的字符串也过，所以拿 package.json 比。
    await app.waitForSelector('[data-field-readonly="general.version"]', 10000);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-field-readonly="general.version"]').textContent`
      )
    ).toBe(EXPECTED_APP_VERSION);
    // 通用分组里只读值只画这一处（索引那条在数据分组，不在此处）。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-field-readonly]').length`)
    ).toBe(1);

    // ④d 数据分组在**真机**里探得到工作区。探测是 `getWorkspaceRoots()` 走 IPC 问主进程
    //     要根目录 —— 「preload 有没有暴露这条通道」「主进程在设置窗口的会话里认不认这个工作区」
    //     这两件事只有真机验证得到，renderer 用例里那个 `window.nexus` 是打桩的。
    await app.click('.nexus-settings-nav [data-section="data"]');
    await app.waitForSelector('[data-field-action="data.rebuildIndex"]', 10000);
    // 这一组从这一批起不再全是按钮：历史快照上限是**带值的**下拉（`data-field-input`）。
    await app.waitForSelector('[data-field-input="data.historyRetention"]', 10000);
    await app.waitForFunction(
      `() => {
        const button = document.querySelector('[data-field-action="data.rebuildIndex"]');
        return Boolean(button) && !button.disabled;
      }`,
      10000
    );
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-field-action]')).map((el) => el.dataset.fieldAction)`
      )
    ).toEqual([
      'data.rebuildIndex',
      'data.openHistoryDirectory',
      'data.openIndexDirectory',
      'data.diagnostics'
    ]);
    // 上限项的档位与默认值 —— 真机里读的是真的 `<option>`，不是打桩的 `settings.get`。
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelector('[data-field-input="data.historyRetention"]').options).map((option) => option.value)`
      )
    ).toEqual(['unlimited', '20', '50', '100', '200']);
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-field-input="data.historyRetention"]').value`
      )
    ).toBe('100');
    // 探到工作区就不该画那行「打开一个工作区后才能使用」。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-field-blocked]').length`)
    ).toBe(0);

    // ④d′ 索引那一项的**只读值**：显示的是主进程算出的库文件路径。
    //     这一条要三样东西同时成立才过：preload 暴露了 `getIndexPath`、主进程在设置窗口的
    //     会话里认这个工作区、`FieldRow` 把值画出来了。renderer 用例里那个 `window.nexus`
    //     是打桩的，证明不了前两样。
    await app.waitForSelector('[data-field-readonly="data.openIndexDirectory"]', 10000);
    const shownIndexPath = await app.evaluate<string>(
      `document.querySelector('[data-field-readonly="data.openIndexDirectory"]').textContent`
    );
    // ① 形状：绝对路径、落在 `workspace-index` 下、文件名是 16 位十六进制加 `.db`。
    expect(shownIndexPath).toMatch(/[\\/]workspace-index[\\/][0-9a-f]{16}\.db$/);
    // ② 它是**本工作区**那一个：文件名与纯函数按主进程授权的那条根算出的摘要一致。
    //    只比 basename 不比整串 —— 前缀是 `userData`，用例看不见它，硬拼一个出来只会
    //    把「路径分隔符规范化」这类无关差异变成红灯。
    const authorizedRoot = await app.evaluate<string[]>(`window.nexus.getWorkspaceRoots()`);
    expect(path.basename(shownIndexPath)).toBe(
      path.basename(indexPathForWorkspace('userData', authorizedRoot[0] as string))
    );
    // ③ 最硬的一条：**建库真的建在这儿**。①② 只证明「同一个函数算了两遍」，
    //    这一条才证明 `openIndexStore` 与设置页走的是同一条路径。索引是进工作区时
    //    侧栏预热建的（用的是启动参数里的原始路径，大小写与这里的根不同），
    //    所以这一条同时是「归一化真的生效」的哨兵 —— 归一没做时它会红，而
    //    ①② 都照样绿。给它一个上限等库文件落盘。
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(shownIndexPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.existsSync(shownIndexPath)).toBe(true);

    // ④d″ 诊断信息：设置页里**唯一**「既画一段文本、又给一个按钮」的字段。
    //
    //      这一段有两个只有真机能证的点：
    //
    //      1. **两条通道都真的暴露了**。renderer 用例里的 `window.nexus` 是打桩的，所以
    //         「preload 忘了暴露 `getDiagnostics`」和「忘了暴露 `copyText`」在那一层都照样绿。
    //      2. **`getDiagnostics` 报的版本与 `app.getVersion()` 一致** —— 也就是与
    //         `package.json` 一致。钉住这一条，是因为它同时证明了「主进程那条 handler
    //         真的被走到」（而不是 renderer 自己拼了一个版本号）。
    //
    //      刻意**不读系统剪贴板**回验：那要 `Get-Clipboard`（Windows 专有），而
    //      `copyText` 返回 `true` 的含义就是 `clipboard.writeText` 被调用过 ——
    //      `writeText` 是同步的，再读回来只能证明同一件事。
    //
    //      **也不比「回执那一行的文案」**：那要拿到字典（真机用例一律只读 DOM，不 import
    //      `@nexus/i18n` 的 dist），而且「`copyText` 返回 `false` 时回执是失败」已经由
    //      `settings-view.test.tsx` 那条 `写剪贴板失败时给失败回执` 钉住了。这一层只管
    //      「通道在不在」—— 不在的话 `run` 会抛，回执是失败，而下面的 `typeof` 判据
    //      会先一步用更清楚的信息红掉。
    expect(
      await app.evaluate<string[]>(
        `[typeof window.nexus.getDiagnostics, typeof window.nexus.copyText]`
      )
    ).toEqual(['function', 'function']);
    await app.waitForSelector('[data-field-readonly="data.diagnostics"]', 10000);
    const shownDiagnostics = await app.evaluate<string>(
      `document.querySelector('[data-field-readonly="data.diagnostics"]').textContent`
    );
    // ① 九个键都在，且顺序固定（`diagnostics-format.test.ts` 钉的规则在真机里照样成立）。
    //    这里索引库已经落盘（上面那条等过 `existsSync`），所以大小与时间两行也在 ——
    //    「文件还没建」那种少两行的形状由 `diagnostics-format.test.ts` 覆盖。
    expect(shownDiagnostics.split('\n').map((line) => line.split(':')[0])).toEqual([
      'version',
      'platform',
      'electron',
      'chromium',
      'node',
      'workspace',
      'index path',
      'index size',
      'index updated'
    ]);
    // ② 版本来自 `app.getVersion()`，与 package.json 一致。
    expect(shownDiagnostics).toContain(`version: ${EXPECTED_APP_VERSION}`);
    // ③ 平台与运行时版本都是真的（`process.*`）—— 形状固定，不写死具体数字。
    expect(shownDiagnostics).toMatch(/\nplatform: win32-x64\n/);
    expect(shownDiagnostics).toMatch(/\nelectron: \d+\.\d+\.\d+/);
    expect(shownDiagnostics).toMatch(/\nchromium: \d+\./);
    expect(shownDiagnostics).toMatch(/\nnode: \d+\.\d+\.\d+\n/);
    // ④ 工作区那一条与主进程授权的那条根一致；索引路径那一条与 `getIndexPath` 给的一致。
    //    这两条是**跨通道一致性**的哨兵：三条通道各自算一遍路径，漂移了就得红。
    expect(shownDiagnostics).toContain(`\nworkspace: ${authorizedRoot[0]}`);
    expect(shownDiagnostics).toContain(`\nindex path: ${shownIndexPath}`);
    // ⑤ 索引文件已经落盘，所以大小与时间两行都该在（它们是文件系统事实）。
    expect(shownDiagnostics).toMatch(/\nindex size: [\d.]+ [KMG]?B \(\d+ bytes\)/);
    expect(shownDiagnostics).toMatch(/\nindex updated: \d{4}-\d{2}-\d{2}T/);
    // ⑥ 报告里**没有文档内容**。这一段是要被整段贴到 issue 里的，混进正文等于泄露笔记。
    //    只钉「正文里那串字没出现」—— 用工作区里那个真实文件的正文。
    expect(shownDiagnostics).not.toContain('正文。');

    // 点按钮：真写一次系统剪贴板。回执那一行必须出现且非空 —— 空回执意味着
    // `run` 走完了但 `setOutcomeKey` 没落地，那是另一种坏法。
    await app.click('[data-field-action="data.diagnostics"]');
    await app.waitForSelector('[data-field-outcome="data.diagnostics"]', 10000);
    expect(
      (
        await app.evaluate<string>(
          `document.querySelector('[data-field-outcome="data.diagnostics"]').textContent`
        )
      ).trim()
    ).not.toBe('');

    // 只读值现在有两处：通用分组的版本、数据分组的索引路径与诊断信息（诊断在数据分组里，
    // 所以本组是**两处**）。别的动作字段跟着多一行时是接线接错了。
    expect(
      await app.evaluate<number>(`document.querySelectorAll('[data-field-readonly]').length`)
    ).toBe(2);

    // ④e 文件与链接分组：八项都由 `FIELDS` 派生渲染，这里只钉住「注册表里加了一项，
    //     真窗口里就真的多一个控件」—— 少一条 `FieldDef` 时 renderer 用例与真机用例
    //     会一起漏，因为两边读的是同一个 `FIELDS`。
    //
    //     这条哨兵**只在跑到本文件时才红**，而真机用例是按批次跑的（见
    //     `memory/build-and-test.md`）—— 加 `FieldDef` 的那一批里如果没有它，
    //     就会像 `files.deleteBehavior`（批一）那样漏到下一次全量才被发现。
    //     顺序即 `FIELDS` 里的顺序，末尾两项也是按那个顺序追加的。
    //
    //     判据：**加 `FieldDef` 时先 `grep` 这个数组**（批一、批二、批三各漏过一次）。
    await app.click('.nexus-settings-nav [data-section="files"]');
    // 这一项是 `radio`，它画的是 `data-field-option` 而不是 `data-field-input`。
    await app.waitForSelector(
      '[data-field-option="files.newDocumentLocation:document"]',
      10000
    );
    expect(
      await app.evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-field]')).map((el) => el.dataset.field)`
      )
    ).toEqual([
      'files.ignoreRules',
      'files.attachmentLocation',
      'files.attachmentDirectory',
      'files.attachmentNameTemplate',
      'files.newDocumentLocation',
      'files.deleteBehavior',
      'files.updateLinksOnRename',
      'files.linkFormat'
    ]);

    // ④f 设置搜索。
    //
    //     这一层要真机才证得到的只有一件事：**内容区真的滚了**。happy-dom 不排版，
    //     `scrollIntoView` 在那儿是个空函数，renderer 用例只能证明「属性挂上去了」。
    //     所以先滚到底，再搜一个**同分组**里靠上的字段 —— 分组不变，`[section]` 那条
    //     「滚回顶部」不会跑，能动的只有搜索那一次跳转。
    //
    //     顺带钉两件 renderer 层证不到的：搜索框在真窗口里真的画出来了（880px 宽的窗口
    //     走的是宽断点那一支），以及别名在**打包后的真界面**里也进了索引。
    await app.click('.nexus-settings-nav [data-section="editor"]');
    await app.waitForSelector('[data-field="editor.spellCheck"]', 10000);
    await app.evaluate(
      `(() => { document.querySelector('.nexus-settings-content').scrollTop = 100000; return true; })()`
    );
    const scrolledToBottom = await app.evaluate<number>(
      `document.querySelector('.nexus-settings-content').scrollTop`
    );
    expect(scrolledToBottom).toBeGreaterThan(0);

    // 敲 `mermaid`：它**只在别名表里**（标签是「点击图表显示源码」/「Click diagram to show source」），
    // 所以这一条同时证明别名真的进了搜索索引。查询串用英文别名而不是中文标签，
    // 是因为真机跑在哪种语言下取决于存档与系统 —— 别名不分语言，标签分。
    await app.evaluate(`(() => {
      const input = document.querySelector('[data-settings-search]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'mermaid');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await app.waitForSelector('[data-search-hit="field:editor.mermaidClickToReveal"]', 10000);
    // 命中别名时那一串原文要画出来 —— 只给标签的话，「敲 mermaid 得到点击图表显示源码」
    // 看起来像撞运气。
    expect(
      await app.evaluate<string>(
        `document.querySelector('[data-search-hit="field:editor.mermaidClickToReveal"] .nexus-settings-search-hit-via').textContent`
      )
    ).toBe('mermaid');
    // 结果行不是按钮。设置页那份「每枚按钮都要落进已知清单」的哨兵在 renderer 层，
    // 这里只顺带钉住真 DOM 里也没多出按钮。
    expect(
      await app.evaluate<number>(
        `document.querySelectorAll('.nexus-settings-search-results button').length`
      )
    ).toBe(0);

    await app.click('[data-search-hit="field:editor.mermaidClickToReveal"]');
    await app.waitForFunction(
      `() => document.querySelector('[data-field="editor.mermaidClickToReveal"]') !== null`,
      10000
    );
    // 查询被清掉、那一页回来了。
    expect(await app.evaluate<string>(`document.querySelector('[data-settings-search]').value`)).toBe(
      ''
    );
    // **滚动真的发生了** —— 从底部回到上面。分组没换，所以这不可能是「切分组滚回顶部」。
    expect(
      await app.evaluate<number>(`document.querySelector('.nexus-settings-content').scrollTop`)
    ).toBeLessThan(scrolledToBottom);

    // ⑤ 跨窗口同步：切回主窗口，它也换过来了。
    //    这条是独立窗口方案最容易漏的地方 —— 两个渲染进程各有一份 `SettingsStore`，
    //    少了主进程中转就是「设置窗口改了、主窗口纹丝不动」。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForFunction(
      `() => document.documentElement.dataset.theme === 'gruvbox-${mode}'`,
      10000
    );
    // 排版变量同样跟过来了 —— 设置窗口里改字号，主窗口的编辑器立刻按新字号排版。
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-font-size')`
      )
    ).toBe('18px');
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-code-line-numbers')`
      )
    ).toBe(expectedLineNumberVar);
    expect(
      await app.evaluate<string>(
        `document.documentElement.style.getPropertyValue('--nx-editor-table-layout')`
      )
    ).toBe(tableLayoutNext);
    // 界面元素显隐也跟过来了 —— 第 ④c‴ 步在设置窗口里藏掉的读数，主窗口的状态栏真的不画了。
    // 这一条是这一批里**只有真机验得到**的一格：renderer 用例的 `window.nexus` 是打桩的，
    // 跨窗口那条路（广播 → 各自 `resyncFromStorage` → 重渲染）在那儿根本不存在。
    await app.waitForFunction(
      `() => document.querySelector('.nexus-status-bar') !== null &&
             document.querySelector('[data-status-metric="format"]') === null`,
      10000
    );
    // 同组里没被藏的那项还在，左侧那半也还在 —— 否则一个「藏一个就全藏」的实现也能让上面那句通过。
    expect(
      await app.evaluate<boolean>(
        `document.querySelector('[data-status-metric="line-column"]') !== null`
      )
    ).toBe(true);
    expect(
      await app.evaluate<boolean>(`document.querySelector('.status-bar-left .status-text') !== null`)
    ).toBe(true);

    // ⑥ 单例：再触发一次不会开出第二个设置窗口。
    //    这里走 `evaluate` 直接调桥、不派发按键 —— 设置窗口持有焦点时主窗口的
    //    `Input.dispatchKeyEvent` 不会被 ack（Chromium 不给非活动页派发输入），
    //    走按键会挂 15s。单例判据与被测的入口无关，用桥更稳。
    await app.evaluate(`window.nexus.openSettingsWindow()`);
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      (await app.pageTargets()).filter((t) => t.url.includes(SETTINGS_WINDOW_URL_MARKER)).length
    ).toBe(1);

    // ⑦ Escape 关掉设置窗口；主窗口不受影响
    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    await app.dispatchKey('Escape');
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 0, 10000);
    expect((await app.pageTargets()).length).toBe(1);

    // ⑧ 关掉之后还能再开 —— 单例是「复用开着的那个」，不是「一辈子只开一次」。
    //    这一条走**活动栏按钮**：设置窗口关了之后焦点回到主窗口，点击派得出去。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    await app.waitForSelector('.nexus-activity-icon[data-activity="settings"]', 10000);
    await app.click('.nexus-activity-icon[data-activity="settings"]');
    await app.waitForPageCount(SETTINGS_WINDOW_URL_MARKER, 1, 15000);

    // ⑨ 界面缩放：**每个窗口各自应用**，所以这条链比主题那条更长 —— 广播 → 两个窗口各自的
    //    `applyUiZoom` → 各自的 `webFrame`。判据取 `window.innerWidth`：缩放改的是**布局视口**，
    //    档位翻一倍视口就该明显变窄。换个 `data-*` 只能证明代码跑了，证明不了窗口真的重排了。
    //
    //    量之前先等宽度稳定：`setZoomFactor` 之后的重排不是同步完成的，直接读会拿到旧值。
    const stableWidth = async (): Promise<number> => {
      let previous = await app.evaluate<number>('window.innerWidth');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const next = await app.evaluate<number>('window.innerWidth');
        if (next === previous) return next;
        previous = next;
      }
      return previous;
    };

    // 基准在主窗口里量，档位也在本窗口里复位 —— `set()` 的订阅是同步的，量到的就是 100% 的宽度。
    // user-data-dir 不按用例隔离，初始档位不能假定是 100%。
    await app.evaluate(
      `(() => { window.nexusSettings.set('appearance.uiZoom', '100'); return true; })()`
    );
    const mainBaseWidth = await stableWidth();

    await app.attachToWindow(SETTINGS_WINDOW_URL_MARKER);
    // 窗口会停在存档里的上次分组（第 ⑤ 步点过 `data`），而缩放字段在外观分组 ——
    // 不切分组就等字段，等的是「当前内容区里永远不出现的节点」。
    await app.click('.nexus-settings-nav [data-section="appearance"]');
    await app.waitForSelector('[data-field-input="appearance.uiZoom"]', 10000);
    await app.evaluate(
      `(() => { window.nexusSettings.set('appearance.uiZoom', '100'); return true; })()`
    );
    const settingsBaseWidth = await stableWidth();

    // 走 UI 改档位（不是直接写桥）：这条链路要验的是「设置页那个下拉框真的接对了」。
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-field-input="appearance.uiZoom"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '200');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    expect(await app.evaluate<string>(`localStorage.getItem('nexus-ui-zoom') ?? ''`)).toBe('200');

    const settingsZoomedWidth = await stableWidth();
    expect(settingsZoomedWidth).toBeLessThan(settingsBaseWidth * 0.6);

    // 主窗口也跟过来 —— 这才是「跨窗口」那条判据。
    await app.attachToWindow(MAIN_WINDOW_URL_MARKER);
    const mainZoomedWidth = await stableWidth();
    expect(mainZoomedWidth).toBeLessThan(mainBaseWidth * 0.6);

    // 复位：把窗口留在 200% 上，后面任何量尺寸的用例都会从一个没预期的布局起步。
    await app.evaluate(
      `(() => { window.nexusSettings.set('appearance.uiZoom', '100'); return true; })()`
    );
    expect(await stableWidth()).toBeGreaterThan(mainBaseWidth * 0.9);

    // 还原字号、藏起来的读数与上次停留的分组：Electron 的 user-data-dir **没有按用例隔离**，
    // 留一个 18px 或「状态栏少一项」在存档里，会让后面任何读它的用例从「别人改过的状态」起步。
    // 走 `localStorage` 直接清，不绕 UI。
    await app.evaluate(
      `localStorage.removeItem('nexus-editor-font-size'); localStorage.removeItem('nexus-editor-code-block-line-numbers'); localStorage.removeItem('nexus-editor-table-layout'); localStorage.removeItem('nexus-settings-section'); localStorage.removeItem('nexus-ui-zoom'); localStorage.removeItem('nexus-ignore-rules'); localStorage.removeItem('nexus-status-bar-hidden'); localStorage.removeItem('nexus-chrome-hidden');`
    );
  }, 120000);
});
