// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BASE16_SLOTS, serializeThemeFile, type NexusThemeScheme, type UserTheme } from '@nexus/theme';
import { scanThemeDirectory, syncThemeDirectory, themeDirectoryPath } from '../electron/theme-directory.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 用户主题目录的扫描与写回。
 *
 * 为什么这一层能在**不启动 Electron** 的前提下把行为测全：模块收的是**目录**而不是自己去问
 * `app.getPath('home')`，所以一个临时目录就是完整的运行环境。主进程那边只负责把路径传进来。
 *
 * 这一层的重点是**失败方向**：
 * - 一个坏文件不能连累其余主题；
 * - 用户刚放进目录、还没被读到的文件**不能**被下一次同步删掉。
 * 两条都只钉正面的话，把坏文件当致命错误、或把目录整个清空重写同样能过。
 */

const PALETTE_DARK: Record<string, string> = Object.fromEntries(
  BASE16_SLOTS.map((slot, index) => [slot, `#${(index + 1).toString(16).padStart(2, '0')}0000`])
);
const PALETTE_LIGHT: Record<string, string> = Object.fromEntries(
  BASE16_SLOTS.map((slot, index) => [slot, `#${(index + 1).toString(16).padStart(2, '0')}ffff`])
);

/** 手写的 base16 形状 —— **逐字贴近上游**，不走 `serializeThemeFile`（那会变成自己验自己）。 */
function base16Yaml(name: string, variant: 'light' | 'dark', palette = PALETTE_DARK): string {
  const lines = ['system: "base16"', `name: "${name}"`, `variant: "${variant}"`, 'palette:'];
  for (const slot of BASE16_SLOTS) lines.push(`  ${slot}: "${palette[slot]}"`);
  return `${lines.join('\n')}\n`;
}

/** 带上 `nexus.id` 的那一种 —— 上游文件里没有这一段。 */
function managedYaml(id: string, name: string, variant: 'light' | 'dark', palette = PALETTE_DARK): string {
  return `${base16Yaml(name, variant, palette)}nexus:\n  id: "${id}"\n`;
}

const schemeOf = (name: string, variant: 'light' | 'dark', palette = PALETTE_DARK): NexusThemeScheme => ({
  name,
  variant,
  palette: palette as NexusThemeScheme['palette']
});

describe('主题目录 · 扫描', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-theme-dir-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const write = (name: string, text: string): void => {
    fs.writeFileSync(path.join(directory, name), text, 'utf8');
  };

  it('目录不存在是常态：返回空表，不抛', () => {
    const missing = path.join(directory, 'nope');
    expect(scanThemeDirectory(missing)).toEqual({ themes: [], broken: [] });
  });

  it('上游文件（没有 nexus.id）：id 从文件名推，一版', () => {
    write('dracula.yaml', base16Yaml('Dracula', 'dark'));

    const scan = scanThemeDirectory(directory);
    expect(scan.broken).toEqual([]);
    expect(scan.themes).toHaveLength(1);
    expect(scan.themes[0]?.id).toBe('user:dracula');
    expect(scan.themes[0]?.variants.dark?.name).toBe('Dracula');
    expect(scan.themes[0]?.variants.light).toBeUndefined();
  });

  it('同一个 nexus.id 的明暗两个文件合成一套主题（一个文件一版）', () => {
    write('ayu.dark.yaml', managedYaml('user:ayu', 'Ayu Dark', 'dark'));
    write('ayu.light.yaml', managedYaml('user:ayu', 'Ayu Light', 'light', PALETTE_LIGHT));

    const scan = scanThemeDirectory(directory);
    expect(scan.broken).toEqual([]);
    expect(scan.themes).toHaveLength(1);
    expect(scan.themes[0]?.id).toBe('user:ayu');
    expect(Object.keys(scan.themes[0]?.variants ?? {}).sort()).toEqual(['dark', 'light']);
  });

  it('同 id 同变体的第二份进 broken，第一份照常可用', () => {
    // 文件名按字典序读，所以 `first` 一定在前 —— 「哪份生效」必须是可预测的，不是文件系统给的顺序。
    write('first.yaml', managedYaml('user:ayu', 'Ayu', 'dark'));
    write('second.yaml', managedYaml('user:ayu', 'Ayu Copy', 'dark'));

    const scan = scanThemeDirectory(directory);
    expect(scan.themes).toHaveLength(1);
    expect(scan.themes[0]?.variants.dark?.name).toBe('Ayu');
    expect(scan.broken).toEqual([{ fileName: 'second.yaml', reason: 'duplicate-variant' }]);
  });

  it('坏文件进 broken 而不连累其余主题（正面 + 反面）', () => {
    write('empty.yaml', '   \n');
    write('short.yaml', 'system: "base16"\nname: "x"\nvariant: "dark"\n');
    write('good.yaml', base16Yaml('Good', 'dark'));

    const scan = scanThemeDirectory(directory);
    expect(scan.themes.map((theme) => theme.id)).toEqual(['user:good']);
    expect(scan.broken).toEqual([
      { fileName: 'empty.yaml', reason: 'empty' },
      { fileName: 'short.yaml', reason: 'missing-slots' }
    ]);
  });

  it('认不出的扩展名与点开头的文件被跳过，且不算坏文件', () => {
    write('.hidden.yaml', base16Yaml('Hidden', 'dark'));
    write('notes.txt', base16Yaml('Notes', 'dark'));
    write('good.yaml', base16Yaml('Good', 'dark'));

    const scan = scanThemeDirectory(directory);
    expect(scan.themes.map((theme) => theme.id)).toEqual(['user:good']);
    expect(scan.broken).toEqual([]);
  });

  it('`@` 在文件名里被换成 `-` —— 选择格式是 `<预设>@<模式>`，多一个 `@` 会把选择切错', () => {
    write('a@b.yaml', base16Yaml('At', 'dark'));
    expect(scanThemeDirectory(directory).themes[0]?.id).toBe('user:a-b');
  });

  it('不是常规文件（同名的目录）算读不动，而不是崩', () => {
    fs.mkdirSync(path.join(directory, 'weird.yaml'));
    write('good.yaml', base16Yaml('Good', 'dark'));

    const scan = scanThemeDirectory(directory);
    expect(scan.themes.map((theme) => theme.id)).toEqual(['user:good']);
    expect(scan.broken).toEqual([{ fileName: 'weird.yaml', reason: 'unreadable' }]);
  });

  it('超过 64KB 的文件直接算读不动（那不是主题文件）', () => {
    write('huge.yaml', `${base16Yaml('Huge', 'dark')}#${'x'.repeat(70 * 1024)}\n`);
    expect(scanThemeDirectory(directory).broken).toEqual([
      { fileName: 'huge.yaml', reason: 'unreadable' }
    ]);
  });
});

describe('主题目录 · 写回', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-theme-sync-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const read = (name: string): string => fs.readFileSync(path.join(directory, name), 'utf8');
  const names = (): string[] => fs.readdirSync(directory).sort();

  const theme = (id: string, variants: UserTheme['variants']): UserTheme => ({ id, variants });

  it('新主题落成 `<slug>.<变体>.yaml`，往返后逐字段相等', () => {
    const list = [
      theme('user:ayu', { dark: schemeOf('Ayu Dark', 'dark'), light: schemeOf('Ayu Light', 'light', PALETTE_LIGHT) })
    ];
    const result = syncThemeDirectory(directory, list, []);

    expect(result).toEqual({ written: 2, removed: 0, failed: [] });
    expect(names()).toEqual(['ayu.dark.yaml', 'ayu.light.yaml']);
    expect(scanThemeDirectory(directory).themes).toEqual(list);
  });

  it('目录为空 / 不存在时也写得出来（先把目录建出来）', () => {
    const fresh = path.join(directory, 'nested', 'themes');
    const result = syncThemeDirectory(fresh, [theme('user:x', { dark: schemeOf('X', 'dark') })], []);
    expect(result.failed).toEqual([]);
    expect(fs.readdirSync(fresh)).toEqual(['x.dark.yaml']);
  });

  it('已有单文件时**沿用原名**，不为了整齐去改用户的文件名', () => {
    fs.writeFileSync(path.join(directory, 'dracula.yaml'), managedYaml('user:dracula', 'Dracula', 'dark'), 'utf8');
    const known = scanThemeDirectory(directory).themes.map((item) => item.id);

    const list = [theme('user:dracula', { dark: schemeOf('Dracula', 'dark') })];
    syncThemeDirectory(directory, list, known);

    expect(names()).toEqual(['dracula.yaml']);
    expect(read('dracula.yaml')).toContain('nexus:\n  id: "user:dracula"');
  });

  it('两版减成一版时，多出来的那个文件删掉', () => {
    const two = [
      theme('user:ayu', { dark: schemeOf('Ayu Dark', 'dark'), light: schemeOf('Ayu Light', 'light', PALETTE_LIGHT) })
    ];
    syncThemeDirectory(directory, two, []);
    expect(names()).toEqual(['ayu.dark.yaml', 'ayu.light.yaml']);

    const result = syncThemeDirectory(directory, [theme('user:ayu', { dark: schemeOf('Ayu Dark', 'dark') })], ['user:ayu']);
    expect(result.removed).toBe(1);
    expect(names()).toEqual(['ayu.dark.yaml']);
  });

  it('从列表里删掉的主题，文件跟着删', () => {
    syncThemeDirectory(directory, [theme('user:ayu', { dark: schemeOf('Ayu', 'dark') })], []);
    const result = syncThemeDirectory(directory, [], ['user:ayu']);

    expect(result).toEqual({ written: 0, removed: 1, failed: [] });
    expect(names()).toEqual([]);
  });

  it('**不在 knownIds 里的文件不删** —— 用户刚放进来、还没被读到的，删掉就是数据丢失', () => {
    syncThemeDirectory(directory, [theme('user:ayu', { dark: schemeOf('Ayu', 'dark') })], []);
    fs.writeFileSync(path.join(directory, 'just-added.yaml'), base16Yaml('Just Added', 'dark'), 'utf8');

    // 同步时列表里只有 ayu，而 knownIds 是「启动时那次扫描」看到的 id —— 不含 just-added。
    const result = syncThemeDirectory(directory, [theme('user:ayu', { dark: schemeOf('Ayu', 'dark') })], ['user:ayu']);

    expect(result.removed).toBe(0);
    expect(names()).toEqual(['ayu.dark.yaml', 'just-added.yaml']);
  });

  it('同名的新主题不会覆盖已有的文件，而是换个词干', () => {
    fs.writeFileSync(path.join(directory, 'ayu.dark.yaml'), base16Yaml('Someone Else', 'dark'), 'utf8');
    const list = [theme('user:mine', { dark: schemeOf('Ayu', 'dark') })];

    syncThemeDirectory(directory, list, []);

    expect(names()).toEqual(['ayu-2.dark.yaml', 'ayu.dark.yaml']);
    // 用户那一份**原样还在**。
    expect(read('ayu.dark.yaml')).toContain('name: "Someone Else"');
    expect(read('ayu-2.dark.yaml')).toContain('nexus:\n  id: "user:mine"');
  });

  it('写出去的内容带上 nexus.id，所以之后改文件名不影响身份', () => {
    const list = [theme('user:9f3c-abc', { dark: schemeOf('Ayu', 'dark') })];
    syncThemeDirectory(directory, list, []);

    const file = names()[0] as string;
    expect(read(file)).toContain('nexus:\n  id: "user:9f3c-abc"');

    fs.renameSync(path.join(directory, file), path.join(directory, 'renamed.yaml'));
    expect(scanThemeDirectory(directory).themes[0]?.id).toBe('user:9f3c-abc');
  });

  it('序列化走的是与导出按钮同一个函数：tuning / overrides 一起落盘', () => {
    const scheme: NexusThemeScheme = {
      ...schemeOf('Ayu', 'dark'),
      tuning: { surfaceHover: 0.04 },
      overrides: { accent: '#e6b450' }
    };
    syncThemeDirectory(directory, [theme('user:ayu', { dark: scheme })], []);

    const text = read('ayu.dark.yaml');
    expect(text).toBe(serializeThemeFile('user:ayu', scheme));
    expect(scanThemeDirectory(directory).themes[0]?.variants.dark?.overrides).toEqual({
      accent: '#e6b450'
    });
  });
});

describe('主题目录 · 路径', () => {
  it('落在 <home>/.nexus/themes', () => {
    expect(themeDirectoryPath('/home/ada')).toBe(path.join('/home/ada', '.nexus', 'themes'));
  });
});
