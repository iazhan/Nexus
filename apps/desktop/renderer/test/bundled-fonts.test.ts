// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 打包字体这条链有四环，**断在任何一环都不报错** —— 只是观感悄悄退回系统字体，
 * 而「退回系统字体」在开发机上往往看不出来（开发者大概率自己装了 JetBrains Mono）。
 *
 *   1. `package.json` 的 `devDependencies` 声明字体包（**不是** `dependencies`，理由见下面那条用例）
 *   2. 入口模块 import 它们（家族名由这一步注册到文档上）
 *   3. `App.css` 的字体栈把家族名排在**第一个**
 *   4. 代码块的等宽栈引用 `--font-mono`，而不是自己再抄一份栈
 *
 * 第 4 环曾经是断的：代码块硬编码 `'JetBrains Mono', 'Fira Code', Menlo, …`，与 `App.css`
 * 那份不一致 —— 打包 `JetBrains Mono Variable` 之后它仍指向静态版，等于用不上打包的字体。
 *
 * 第 3 环还比「家族名写没写」更进一步：家族名是**字体包自己声明**的，fontsource 升级换过名字
 * （`Inter` → `Inter Variable`），写错或包改名都不会有报错，所以这里拿包里的样式表当事实源。
 */

const SRC_DIR = path.resolve(__dirname, '../src');
const APP_CSS = path.join(SRC_DIR, 'App.css');
const ENTRY = path.join(SRC_DIR, 'main.tsx');
const PKG = path.resolve(__dirname, '../../package.json');
const EDITOR_THEME = path.resolve(__dirname, '../../../../packages/editor/src/theme.ts');

/** 打包的两个家族：包名 → `App.css` 里引用它的变量。 */
const BUNDLED = [
  { pkg: '@fontsource-variable/inter', cssVar: '--font-family' },
  { pkg: '@fontsource-variable/jetbrains-mono', cssVar: '--font-mono' }
] as const;

const require_ = createRequire(import.meta.url);

/** 字体包自己声明的家族名 —— 不在这里手抄，否则包改名时这条用例跟着一起错。 */
function declaredFamily(pkg: string): string {
  const css = fs.readFileSync(require_.resolve(pkg), 'utf-8');
  const found = /font-family:\s*['"]([^'"]+)['"]/.exec(css);
  if (!found) {
    throw new Error(`${pkg} 的样式表里找不到 font-family`);
  }
  return found[1]!;
}

/** 取某个自定义属性的第一个候选，去掉引号 —— 只比第一个，栈里天生含兜底项。 */
function firstCandidate(css: string, prop: string): string {
  const found = new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(css);
  if (!found) {
    throw new Error(`App.css 里找不到 ${prop}`);
  }
  return found[1]!.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
}

describe('打包字体', () => {
  it('两个字体包都声明为构建期依赖，且没有落进 dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const missing = BUNDLED.map((entry) => entry.pkg).filter(
      (name) => !pkg.devDependencies?.[name]
    );
    expect(missing, `devDependencies 里没有这些字体包：${missing.join(', ')}`).toEqual([]);

    // 落进 `dependencies` 的后果是**静默的**：electron-builder 会顺着依赖树把它们再收一遍进
    // asar（实测 34.8MB → 113MB），功能一切正常，只有安装包白白胖三倍。渲染进程由 Vite 打包，
    // 字体连 woff2 一起进 `out/renderer/assets`，运行期不读 node_modules —— 所以这一条与
    // 「声明了没有」同等重要，不能只写前一半。判据的完整论述见 `electron.vite.config.ts` 头注释。
    const leaked = BUNDLED.map((entry) => entry.pkg).filter((name) => pkg.dependencies?.[name]);
    expect(
      leaked,
      `这些字体包不该出现在 dependencies（安装包会胖三倍）：${leaked.join(', ')}`
    ).toEqual([]);
  });

  it('入口模块 import 了两个字体包（家族名由这一步注册）', () => {
    const entry = fs.readFileSync(ENTRY, 'utf-8');

    const missing = BUNDLED.map((entry) => entry.pkg).filter(
      (name) => !new RegExp(`^import\\s+'${name}';`, 'm').test(entry)
    );
    expect(missing, `main.tsx 没有 import：${missing.join(', ')}`).toEqual([]);
  });

  it('字体栈的第一个候选就是打包的家族名', () => {
    const css = fs.readFileSync(APP_CSS, 'utf-8');

    for (const { pkg, cssVar } of BUNDLED) {
      expect(firstCandidate(css, cssVar), `${cssVar} 的首候选不是打包字体`).toBe(
        declaredFamily(pkg)
      );
    }
  });

  it('代码块的等宽栈引用 --font-mono，不另抄一份', () => {
    const theme = fs.readFileSync(EDITOR_THEME, 'utf-8');

    expect(theme).toContain('var(--font-mono');
    expect(theme, '编辑器包里又出现了一份硬编码的等宽栈').not.toContain("'JetBrains Mono'");
  });
});

/**
 * 界面中文的唯一定义处。两条栈（`--font-family` / `--font-mono`）里的拉丁字体都只有拉丁字形，
 * 中文全靠 `--font-cjk` 兜底 —— 谁少引一次，那一处的中文就掉回浏览器的平台兜底。
 *
 * 这个失效**不报错、不破版**：2026-10-01 真机实测（`CSS.getPlatformFontsForNode`），
 * 当时 `--font-mono` 只列了 `"Sarasa Mono SC"`，没装 Sarasa 的机器上中文命中 **NSimSun（新宋体）**，
 * 而界面栈命中 `Microsoft YaHei` —— 同一个界面上侧栏是雅黑、状态栏计数是新宋体。
 * 截图看不出来（两种黑体字差别很小），只能靠这条用例拦。
 */
describe('界面中文的唯一定义处', () => {
  // **必须先剥注释再扫。** App.css 的注释里成篇讨论字体栈（含 `font-family: inherit` 这样的
  // 示例、以及 `--font-family` 这种变量名），不剥的话正则会把注释当声明扫进来，
  // 而且 `[^;]+` 能跨行，一条注释会吞掉后面几十行的真声明 —— 报出来的「违规栈」是散文。
  const css = fs.readFileSync(APP_CSS, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

  /** 取某个自定义属性的整条值 —— 与 `firstCandidate` 同一个正则，只取全串。 */
  function stackOf(prop: string): string {
    const found = new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(css);
    if (!found) throw new Error(`App.css 里找不到 ${prop}`);
    return found[1]!;
  }

  const CJK_NAMES = /YaHei|PingFang|Noto Sans CJK|Sarasa|SimSun|SimHei|KaiTi|宋体|黑体|楷体/;

  it('--font-cjk 有定义', () => {
    expect(css, '--font-cjk 没有定义，两条栈的 var() 会整条失效').toMatch(/--font-cjk\s*:\s*[^;]+;/);
  });

  it('界面栈与等宽栈都引用 --font-cjk，不各抄一份', () => {
    for (const prop of ['--font-family', '--font-mono']) {
      expect(stackOf(prop), `${prop} 没有引用 --font-cjk`).toContain('var(--font-cjk)');
    }
  });

  it('两条栈自己都不列中文字体名（那是 --font-cjk 的事）', () => {
    for (const prop of ['--font-family', '--font-mono']) {
      expect(stackOf(prop), `${prop} 里又抄了一份中文候选`).not.toMatch(CJK_NAMES);
    }
  });

  it('App.css 里没有第三条自己写的字体栈', () => {
    // 一条字面量栈不引 `var(--font-cjk)` 只有两种下场：末尾是个 generic（`monospace` /
    // `sans-serif` / `serif`）时中文归平台的 CJK 兜底 —— Windows 上是 NSimSun，与界面中文
    // （雅黑）同屏并存且不报错；要么就是自己又抄了一份中文候选，两份迟早漂移。
    // 历史面板的 `.nexus-history-hash` / `.nexus-history-diff-lines` 是前一种（已改成引用）。
    // 只认「字面量栈」：`inherit` 是继承，`var(--x)` 是引用别处那条已经合规的栈，两者都跳过。
    const offenders = [...css.matchAll(/font-family\s*:\s*([^;]+);/g)]
      .map((m) => m[1]!.trim())
      .filter(
        (value) =>
          value !== 'inherit' &&
          !/^var\(--[\w-]+\)$/.test(value) &&
          !value.includes('var(--font-cjk)')
      );

    expect(
      offenders,
      `这些 font-family 没引用 var(--font-cjk)：${offenders.join(' | ')}`
    ).toEqual([]);
  });
});
