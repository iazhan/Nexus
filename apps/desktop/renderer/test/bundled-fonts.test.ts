// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 打包字体这条链有四环，**断在任何一环都不报错** —— 只是观感悄悄退回系统字体，
 * 而「退回系统字体」在开发机上往往看不出来（开发者大概率自己装了 JetBrains Mono）。
 *
 *   1. `package.json` 声明字体包
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
  it('两个字体包都声明在依赖里', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    const missing = BUNDLED.map((entry) => entry.pkg).filter((name) => !pkg.dependencies?.[name]);
    expect(missing, `package.json 里没有这些依赖：${missing.join(', ')}`).toEqual([]);
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
