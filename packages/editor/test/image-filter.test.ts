import { describe, expect, it } from 'vitest';
import { filterImageOptions, isCurrentImageOption } from '../src/inline/image-filter.js';
import type { WorkspaceImageOption } from '../src/inline/types.js';

function image(path: string, name?: string, wikiPath?: string): WorkspaceImageOption {
  return {
    path,
    wikiPath: wikiPath ?? path,
    name: name ?? path.slice(path.lastIndexOf('/') + 1),
    url: `nexus-asset://ws/?path=${encodeURIComponent(path)}`
  };
}

/**
 * 图片候选列表的过滤。
 *
 * 契约：列表跟着**当前输入的地址**走 —— 它是自动补全，不是整个工作区的相册。
 * 重点在优先级：前缀（正在打的就是它）要压过包含（打错开头也能捞回来）。
 */
describe('图片候选过滤', () => {
  const items: WorkspaceImageOption[] = [
    image('assets/MAIN.png'),
    image('assets/main-old.png'),
    image('assets/other.png'),
    image('../shared/MAIN.png')
  ];

  it('输入为空时列出全部 —— 那正是「想看有什么」的时刻', () => {
    expect(filterImageOptions(items, '')).toHaveLength(4);
    expect(filterImageOptions(items, '   ')).toHaveLength(4);
  });

  it('文件名前缀匹配，大小写不敏感', () => {
    const matched = filterImageOptions(items, 'main');
    expect(matched.map((item) => item.path)).toEqual([
      'assets/MAIN.png',
      'assets/main-old.png',
      '../shared/MAIN.png'
    ]);
  });

  it('输入落在目录段上时按目录过滤', () => {
    const matched = filterImageOptions(items, 'assets/');
    expect(matched.map((item) => item.path)).toEqual([
      'assets/MAIN.png',
      'assets/main-old.png',
      'assets/other.png'
    ]);
  });

  it('名称包含输入时兜底捞出（开头打错也能找到）', () => {
    const matched = filterImageOptions(items, 'ain');
    expect(matched.map((item) => item.path)).toEqual([
      'assets/MAIN.png',
      'assets/main-old.png',
      '../shared/MAIN.png'
    ]);
  });

  it('前缀优先于包含', () => {
    const mixed = [image('a/xmain.png'), image('b/main.png')];
    expect(filterImageOptions(mixed, 'main').map((item) => item.path)).toEqual([
      'b/main.png',
      'a/xmain.png'
    ]);
  });

  it('`./` 与 `\\` 都归一到同一形状再比', () => {
    expect(filterImageOptions(items, './MAIN.png').map((item) => item.path)).toEqual([
      'assets/MAIN.png',
      '../shared/MAIN.png'
    ]);
    expect(filterImageOptions(items, 'assets\\main').map((item) => item.path)).toEqual([
      'assets/MAIN.png',
      'assets/main-old.png'
    ]);
  });

  it('什么都匹配不上时返回空，由调用方给提示', () => {
    expect(filterImageOptions(items, 'zzz')).toEqual([]);
  });

  it('同优先级内保持原顺序（宿主怎么排就怎么排）', () => {
    const ordered = [image('z/main.png'), image('a/main.png')];
    expect(filterImageOptions(ordered, 'main').map((item) => item.path)).toEqual([
      'z/main.png',
      'a/main.png'
    ]);
  });

  it('标出当前地址指向的那张（面板的「预选」）', () => {
    const current = image('assets/MAIN.png');
    expect(isCurrentImageOption(current, 'assets/MAIN.png')).toBe(true);
    // `./` 与大小写是同一处的不同写法，不该影响判断
    expect(isCurrentImageOption(current, './assets/main.png')).toBe(true);
    // 只是前缀相同不算「当前那张」
    expect(isCurrentImageOption(current, 'assets')).toBe(false);
    // 地址空着 / 写了一半时没有「当前那张」
    expect(isCurrentImageOption(current, '')).toBe(false);
  });

  it('嵌入档按最短唯一路径过滤 —— 两份地址不同，用错那份一条都命不中', () => {
    const items = [
      image('../assets/x.png', 'x.png', 'assets/x.png'),
      image('local.png', 'local.png', 'local.png')
    ];

    // `![](…)` 档：地址相对当前文档目录
    expect(filterImageOptions(items, '../assets').map((item) => item.path)).toEqual([
      '../assets/x.png'
    ]);
    // `![[…]]` 档：同一张图要打工作区根相对的那份才命中
    expect(filterImageOptions(items, 'assets', 'wiki').map((item) => item.wikiPath)).toEqual([
      'assets/x.png'
    ]);
    expect(filterImageOptions(items, '../assets', 'wiki')).toEqual([]);
  });

  it('预选也按同一档比 —— 嵌入档认 wikiPath，不认文档目录相对', () => {
    const item = image('../assets/x.png', 'x.png', 'assets/x.png');

    expect(isCurrentImageOption(item, 'assets/x.png', 'wiki')).toBe(true);
    expect(isCurrentImageOption(item, 'assets/x.png')).toBe(false);
    expect(isCurrentImageOption(item, '../assets/x.png')).toBe(true);
  });
});
