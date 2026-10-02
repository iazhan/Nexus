// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRAPH_HIDDEN_TYPES_STORAGE_KEY,
  GRAPH_MODE_DEFAULT,
  GRAPH_MODES,
  GRAPH_SCOPE_DEFAULT,
  GRAPH_SCOPES,
  parseGraphHiddenTypes,
  serializeGraphHiddenTypes
} from '../src/settings/preference-specs.js';
import { SettingsStore } from '../src/settings/store.js';
import { settings } from '../src/platform.js';

/**
 * 图谱视图状态的**值域与落盘**。
 *
 * 消费端（面板的渲染与请求参数）有自己的用例；这里只管三件事：值域对不对、
 * 认不出的存档怎么办、写进去读回来是不是同一个值。
 *
 * 最后一条是这一层真正容易错的地方：这三项是**视图状态**，落盘是它们的全部意义 ——
 * 值域对但读不回来，等于没做。
 *
 * `apps/desktop/renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

describe('图谱视图状态：值域', () => {
  it('默认值等于加这些开关之前的观感', () => {
    expect(GRAPH_MODE_DEFAULT).toBe('explore');
    expect(GRAPH_SCOPE_DEFAULT).toBe('all');
    // 默认「什么都没关掉」= 不过滤
    expect(parseGraphHiddenTypes(null)).toEqual([]);
  });

  it('三个视图与两种范围的取值域是封闭的', () => {
    expect([...GRAPH_MODES]).toEqual(['explore', 'orphans', 'hubs']);
    expect([...GRAPH_SCOPES]).toEqual(['all', 'current']);
  });
});

describe('图谱视图状态：被关掉的类型', () => {
  it('按清单顺序输出 —— 同一个集合只有一种写法', () => {
    // 顺序不稳的话，「存档里的值」与「内存里的值」会看起来不同，去重与比较都会失效
    expect(parseGraphHiddenTypes('image,pdf')).toEqual(['pdf', 'image']);
    expect(parseGraphHiddenTypes('pdf,image')).toEqual(['pdf', 'image']);
  });

  it('认不出的名字丢掉，不是整条作废', () => {
    // 用户能改 localStorage，也能从旧版本升上来
    expect(parseGraphHiddenTypes('pdf,nonsense')).toEqual(['pdf']);
    expect(parseGraphHiddenTypes('nonsense')).toEqual([]);
  });

  it('重复与空白都被吃掉', () => {
    expect(parseGraphHiddenTypes(' pdf , pdf ,, pdf ')).toEqual(['pdf']);
  });

  it('空串与 null 都是「不过滤」', () => {
    expect(parseGraphHiddenTypes('')).toEqual([]);
    expect(parseGraphHiddenTypes('   ')).toEqual([]);
    expect(parseGraphHiddenTypes(undefined)).toEqual([]);
  });

  it('序列化与解析互为逆', () => {
    const hidden = parseGraphHiddenTypes('docx,markdown');
    expect(parseGraphHiddenTypes(serializeGraphHiddenTypes(hidden))).toEqual(hidden);
    // 空集合序列化成空串，再读回来还是空集合
    expect(serializeGraphHiddenTypes([])).toBe('');
    expect(parseGraphHiddenTypes(serializeGraphHiddenTypes([]))).toEqual([]);
  });
});

describe('图谱视图状态：落盘', () => {
  afterEach(() => {
    // 这几项现在会写进 localStorage，**跨用例残留**。不还原的话「默认是 explore」
    // 那条断言会在别的用例改过之后失效 —— 而单跑又是绿的。
    settings.set('graph.mode', GRAPH_MODE_DEFAULT);
    settings.set('graph.scope', GRAPH_SCOPE_DEFAULT);
    settings.set('graph.hiddenTypes', []);
  });

  it('写进去读回来是同一个值', () => {
    settings.set('graph.mode', 'hubs');
    settings.set('graph.scope', 'current');
    settings.set('graph.hiddenTypes', ['pdf', 'image']);

    expect(settings.get('graph.mode')).toBe('hubs');
    expect(settings.get('graph.scope')).toBe('current');
    expect(settings.get('graph.hiddenTypes')).toEqual(['pdf', 'image']);
  });

  it('磁盘上的坏值回落到默认，而不是渲染不出来的值', () => {
    /*
      必须用**新建的** store 读：单例在第一次读之后就把值缓存在内存里，
      直接改 localStorage 它看不见 —— 那种写法下断言恒真，测的是缓存而不是解析。
      `settings-store.test.ts` 的「读初值」一组用的是同一个手法。
    */
    localStorage.setItem('nexus-graph-mode', 'nonsense');
    localStorage.setItem('nexus-graph-scope', 'nonsense');
    localStorage.setItem(GRAPH_HIDDEN_TYPES_STORAGE_KEY, 'pdf,nonsense');

    const fresh = new SettingsStore();
    // 认不出的档位回落默认 —— 留着一个渲染不出来的值会让控件一个都不选中
    expect(fresh.get('graph.mode')).toBe(GRAPH_MODE_DEFAULT);
    expect(fresh.get('graph.scope')).toBe(GRAPH_SCOPE_DEFAULT);
    // 类型这一项丢掉认不出的名字，保留认识的
    expect(fresh.get('graph.hiddenTypes')).toEqual(['pdf']);
  });

  it('没有存档时三项都读默认值', () => {
    localStorage.clear();

    const fresh = new SettingsStore();
    expect(fresh.get('graph.mode')).toBe(GRAPH_MODE_DEFAULT);
    expect(fresh.get('graph.scope')).toBe(GRAPH_SCOPE_DEFAULT);
    expect(fresh.get('graph.hiddenTypes')).toEqual([]);
  });
});
