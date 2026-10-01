import { describe, expect, it } from 'vitest';
import { translate } from '@nexus/i18n';
import { FIELDS, SECTIONS } from '../src/settings/registry.js';
import { SEARCH_LIMIT, searchSettings } from '../src/settings/settings-search.js';

/**
 * 设置搜索的纯逻辑（`settings-search.ts`）。
 *
 * 这一层要盯的是**三类目标（标签 / 别名 / id）的取舍**，不是 DOM —— 视图层那几条在
 * `settings-view.test.tsx` 的「设置视图 · 搜索」里。
 *
 * 判据绑一个具体语言：候选里含**翻译出来的标签**，不绑语言的话「敲 dark 命中模式」这条
 * 在英文界面下会变成「敲 dark 命中 Mode」，断言写得含糊就测不出东西。
 *
 * 最后那两条（每个字段 / 每个分组都能被自己的名字搜到）是这一层的**兜底哨兵** ——
 * 它们不针对某一条，而是保证「注册表里加一项」不会悄悄变成「搜索里搜不到那一项」。
 */

const zh = (key: string, vars?: Record<string, string>): string => translate('zh-CN', key, vars);
const en = (key: string, vars?: Record<string, string>): string => translate('en-US', key, vars);

/** 取全部命中（不截断）—— 好几条判据要的正是「有没有排在很后面」。 */
const all = (query: string, t = zh): ReturnType<typeof searchSettings> =>
  searchSettings(query, t, 500);

const keysOf = (query: string, t = zh): string[] => all(query, t).map((hit) => hit.key);

describe('设置搜索 · 三类目标', () => {
  it('空查询与纯空白都返回空 —— 「什么都没敲」不等于「列出全部」', () => {
    expect(searchSettings('', zh)).toEqual([]);
    expect(searchSettings('   ', zh)).toEqual([]);
  });

  it('标签命中：位置信息供高亮，via 为空（命中的就是显示名本身）', () => {
    const hits = all('正文字号');

    const hit = hits.find((candidate) => candidate.key === 'field:editor.fontSize');
    expect(hit).toBeDefined();
    expect(hit?.label).toBe(zh('settings.editor.fontSize'));
    expect(hit?.via).toBeNull();
    // 高亮用的是**标签里**的下标，所以它必须落在标签长度之内且升序 ——
    // 拿别名命中的下标去高亮标签会错位，那正是 `via` 要区分的东西。
    expect(hit?.positions.length).toBeGreaterThan(0);
    expect(hit?.positions).toEqual([...hit!.positions].sort((a, b) => a - b));
    expect(Math.max(...hit!.positions)).toBeLessThan(hit!.label.length);
  });

  it('别名命中：via 是那一串别名，positions 为空', () => {
    const hits = all('暗色');

    const hit = hits.find((candidate) => candidate.key === 'field:appearance.themeMode');
    expect(hit).toBeDefined();
    // 标签是「模式」两个字，敲「暗色」时它一个字都不沾 —— 这一条正是别名机制存在的理由。
    expect(hit?.label).toBe(zh('settings.appearance.themeMode'));
    expect(hit?.via).toBe('暗色');
    expect(hit?.positions).toEqual([]);
  });

  it('中文界面下敲英文别名同样命中（别名表不分语言）', () => {
    expect(keysOf('dark', zh)).toContain('field:appearance.themeMode');
  });

  it('英文界面下敲中文别名同样命中', () => {
    expect(keysOf('暗色', en)).toContain('field:appearance.themeMode');
    // 但标签是英文的 —— 别名的命中不该把标签也一起「翻译」掉。
    expect(all('暗色', en).find((hit) => hit.key === 'field:appearance.themeMode')?.label).toBe(
      en('settings.appearance.themeMode')
    );
  });

  it('分组也进候选 —— 敲组名要能跳到那一组', () => {
    const hits = all('快捷键');

    const hit = hits.find((candidate) => candidate.key === 'section:keybindings');
    expect(hit).toBeDefined();
    // 分组命中没有可跳转的行，视图层据此只切页、不滚动。
    expect(hit?.field).toBeNull();
    expect(hit?.section).toBe('keybindings');
  });

  it('id 命中排最后：via 是 id 原文，positions 为空', () => {
    const hits = all('themePreset');

    const hit = hits.find((candidate) => candidate.key === 'field:appearance.themePreset');
    expect(hit).toBeDefined();
    expect(hit?.via).toBe('appearance.themePreset');
    expect(hit?.positions).toEqual([]);
  });
});

describe('设置搜索 · 权重', () => {
  /**
   * 标签 > 别名。「主题」同时命中 `appearance.themePreset` 的**标签**与 `appearance` 分组的
   * **别名** —— 用户敲的是屏幕上看得见的那两个字，那一项该排在前面。
   */
  it('标签命中排在别名命中之前', () => {
    const keys = keysOf('主题');

    const byLabel = keys.indexOf('field:appearance.themePreset');
    const byAlias = keys.indexOf('section:appearance');

    expect(byLabel).toBeGreaterThanOrEqual(0);
    expect(byAlias).toBeGreaterThanOrEqual(0);
    expect(byLabel).toBeLessThan(byAlias);
  });

  /**
   * 别名 > id。`mode` 命中 `appearance.themeMode` 的别名，也命中 `editor.typewriterMode` 的 id
   * （`typewriterMode` 里正好含这四个字母）—— id 不压住的话，敲 `a` 之类会得到一屏 id 命中。
   */
  it('别名命中排在 id 命中之前', () => {
    const keys = keysOf('mode');

    expect(keys.indexOf('field:appearance.themeMode')).toBeLessThan(
      keys.indexOf('field:editor.typewriterMode')
    );
  });
});

describe('设置搜索 · 结果形状', () => {
  it('一个字段只出现一次（多个目标都命中时取分最高的那个）', () => {
    const keys = keysOf('字体');

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('limit 截断结果，默认上限是 30', () => {
    expect(searchSettings('e', zh).length).toBe(SEARCH_LIMIT);
    expect(searchSettings('e', zh, 3).length).toBe(3);
  });

  /**
   * 兜底哨兵：**每个字段都能被自己的标签搜到**。
   *
   * 加一项设置时最容易漏的一步就是「忘了它进搜索」—— 而漏了不会报任何错，只是用户搜不到。
   * 这条把「注册表里的每一项都可达」变成断言，中英两边都测：标签是翻译出来的，
   * 只测一边的话，另一种语言里可能有一个谁也没见过的键名被当成标签。
   */
  it.each([
    { name: '中文', t: zh },
    { name: '英文', t: en }
  ])('$name 界面下每个字段都能被自己的标签搜到', ({ t }) => {
    for (const field of FIELDS) {
      const label = t(field.labelKey);
      expect(keysOf(label, t), `${field.id} 的标签「${label}」搜不到自己`).toContain(
        `field:${field.id}`
      );
    }
  });

  it('每个分组都能被自己的名字搜到', () => {
    for (const section of SECTIONS) {
      const title = zh(section.titleKey);
      expect(keysOf(title), `${section.id} 的组名「${title}」搜不到自己`).toContain(
        `section:${section.id}`
      );
    }
  });
});
