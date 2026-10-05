// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import {
  ExtensionHost,
  mountExtension,
  type EditorExtension,
  type ExtensionLoader
} from '../src/extensions.js';
import {
  isMathMarker,
  isMermaidMarker,
  isMermaidLanguage,
  MATH_EXTENSION_ID,
  MERMAID_EXTENSION_ID
} from '../src/extension-triggers.js';
import type { MarkdownMarker } from '../src/types.js';

describe('ExtensionHost', () => {
  it('registers and retrieves handlers', () => {
    const host = new ExtensionHost();
    const mockExt: EditorExtension = {
      id: 'mock',
      canHandle: (marker) => marker.type === 'inline-math',
      load: async () => {},
      activate: () => ({ update: () => {}, destroy: () => {} })
    };
    host.register(mockExt);

    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })).toBe(mockExt);
    expect(host.getHandler({ type: 'block-math', from: 0, to: 1 })).toBeUndefined();
  });
});

/**
 * 启停。谓词是**注入的**、且**每次查表时求值** —— 于是改设置立即生效：
 * 不用重新注册（`registerLazy` 对重复 id 是抛错的）、不用重启。
 *
 * 每条都带反面：只断言「关掉的那个查不到」对「把什么都查不到」同样成立。
 */
describe('ExtensionHost 启停', () => {
  const noopExtension = (id: string): EditorExtension => ({
    id,
    canHandle: () => true,
    load: async () => {},
    activate: () => ({ update: () => {}, destroy: () => {} })
  });

  it('关掉的扩展不认领 marker，没关的照常认领', () => {
    const host = new ExtensionHost((id) => id !== 'mock');
    host.register(noopExtension('mock'));
    host.register(noopExtension('other'));

    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })?.id).toBe('other');
    expect(host.isCapabilityEnabled('mock')).toBe(false);
    expect(host.isCapabilityEnabled('other')).toBe(true);
  });

  /**
   * 两个扩展认领同一种 marker（`registerLazy` 不禁止这件事）时，关掉前一个应该**落到
   * 后一个**上，而不是让这个 marker 没人管。
   *
   * 这正是 `getHandler` 写成「跳过被禁用的」而不是「提前返回 undefined」的原因 ——
   * 后者会让整篇文档的公式退回源码，只因为第一个认领者被关掉了。
   */
  it('前一个认领者被关掉时落到后一个，而不是整个 marker 无人认领', () => {
    const host = new ExtensionHost((id) => id !== 'first');
    host.register(noopExtension('first'));
    host.register(noopExtension('second'));

    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })?.id).toBe('second');
  });

  it('listExtensions 报 disabled，且排在加载态之前', () => {
    const host = new ExtensionHost((id) => id !== 'mock-lazy');
    const loader: ExtensionLoader = {
      id: 'mock-lazy',
      matches: isMathMarker,
      load: async () => noopExtension('mock-lazy')
    };
    host.registerLazy(loader);
    host.register(noopExtension('mock-static'));

    expect(host.listExtensions()).toEqual([
      { id: 'mock-lazy', state: 'disabled' },
      // 关掉一个不能连累另一个 —— 否则「关掉 math、mermaid 也停了」也能过上面那条
      { id: 'mock-static', state: 'loaded' }
    ]);
  });

  it('改谓词立即生效，不用重新注册', async () => {
    let disabled = false;
    const host = new ExtensionHost(() => !disabled);
    host.registerLazy({
      id: 'mock-lazy',
      matches: isMathMarker,
      load: async () => noopExtension('mock-lazy')
    });

    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })).toBeDefined();

    disabled = true;
    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })).toBeUndefined();
    expect(host.listExtensions()).toEqual([{ id: 'mock-lazy', state: 'disabled' }]);

    // 再打开：注册表一个字节都没动过，只是谓词换了答案。包还没加载过，所以回到 idle
    // （而不是 disabled）——「关掉再打开」不该顺手把包加载了。
    disabled = false;
    expect(host.getHandler({ type: 'inline-math', from: 0, to: 1 })).toBeDefined();
    expect(host.listExtensions()).toEqual([{ id: 'mock-lazy', state: 'idle' }]);
  });

  /**
   * `disabled` 不能并进 `idle`：两者都「没加载」，但 `idle` 的意思是「用到它就会加载」，
   * `disabled` 是「用到了也不会加载」。画成同一个词就是谎报现状。
   */
  it('没被关掉也没被触发的扩展仍是 idle，不是 disabled', () => {
    const host = new ExtensionHost((id) => id !== 'other');
    host.registerLazy({
      id: 'mock-lazy',
      matches: isMathMarker,
      load: async () => noopExtension('mock-lazy')
    });

    expect(host.listExtensions()).toEqual([{ id: 'mock-lazy', state: 'idle' }]);
  });
});

describe('mountExtension', () => {
  it('mounts synchronously and renders loading state', async () => {
    const host = new ExtensionHost();
    const loadPromise = Promise.resolve();
    let activateCalled = false;

    const mockExt: EditorExtension = {
      id: 'mock',
      canHandle: () => true,
      load: () => loadPromise,
      activate: (marker, container, source) => {
        activateCalled = true;
        container.textContent = 'activated ' + source;
        return { update: () => {}, destroy: () => {} };
      }
    };
    host.register(mockExt);

    const container = document.createElement('div');
    const fallback = vi.fn();
    const control = mountExtension(
      host,
      { type: 'inline-math', from: 0, to: 1 },
      container,
      'source',
      fallback
    );

    expect(control).toBeDefined();
    expect(fallback).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('Loading...');

    await loadPromise;
    await new Promise(r => setTimeout(r, 0)); // wait for promise chain

    expect(activateCalled).toBe(true);
    expect(container.textContent).toBe('activated source');
  });

  it('calls fallback if host or handler is missing', () => {
    const container = document.createElement('div');
    const fallback = vi.fn();
    
    const control1 = mountExtension(undefined, { type: 'inline-math', from: 0, to: 1 }, container, 'source', fallback);
    expect(control1).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);

    const host = new ExtensionHost();
    const control2 = mountExtension(host, { type: 'inline-math', from: 0, to: 1 }, container, 'source', fallback);
    expect(control2).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('renders error and retry if load fails', async () => {
    const host = new ExtensionHost();
    let rejectLoad: (err: any) => void;
    const loadPromise = new Promise<void>((_, reject) => {
      rejectLoad = reject;
    });

    const mockExt: EditorExtension = {
      id: 'mock-fail',
      canHandle: () => true,
      load: () => loadPromise,
      activate: () => ({ update: () => {}, destroy: () => {} })
    };
    host.register(mockExt);

    const container = document.createElement('div');
    mountExtension(
      host,
      { type: 'inline-math', from: 0, to: 1 },
      container,
      'source',
      vi.fn()
    );

    expect(container.innerHTML).toContain('Loading...');

    rejectLoad!(new Error('Network error'));
    await new Promise(r => setTimeout(r, 0));

    expect(container.innerHTML).toContain('nexus-ext-error');
    expect(container.textContent).toContain('Plugin unavailable: mock-fail');
    expect(container.querySelector('button.nexus-ext-retry')).toBeTruthy();
  });
});

const inlineMath: MarkdownMarker = { type: 'inline-math', from: 0, to: 1 };
const blockMath: MarkdownMarker = { type: 'block-math', from: 0, to: 1 };
const mermaidFence: MarkdownMarker = { type: 'code-fence', from: 0, to: 1, language: 'mermaid' };

function makeInner(id: string, matches: (m: MarkdownMarker) => boolean): EditorExtension {
  return {
    id,
    canHandle: matches,
    load: async () => {},
    activate: (_marker, container, source) => {
      container.textContent = `${id}:${source}`;
      return { update: () => {}, destroy: () => {} };
    }
  };
}

function makeLoader(id: string, matches: (m: MarkdownMarker) => boolean) {
  const inner = makeInner(id, matches);
  const loader: ExtensionLoader = {
    id,
    matches,
    load: vi.fn(async () => inner)
  };
  return { loader, inner };
}

describe('extension triggers', () => {
  it('isMathMarker 只认两种公式', () => {
    expect(isMathMarker(inlineMath)).toBe(true);
    expect(isMathMarker(blockMath)).toBe(true);
    expect(isMathMarker(mermaidFence)).toBe(false);
    expect(isMathMarker({ type: 'wikilink', from: 0, to: 1 })).toBe(false);
  });

  it('isMermaidMarker 只认 mermaid 围栏，且语言大小写不敏感', () => {
    expect(isMermaidMarker(mermaidFence)).toBe(true);
    expect(isMermaidMarker({ type: 'code-fence', from: 0, to: 1, language: 'Mermaid' })).toBe(true);
    expect(isMermaidMarker({ type: 'code-fence', from: 0, to: 1, language: 'js' })).toBe(false);
    // 无语言围栏不能算 mermaid，否则每个代码块都会把 1.2MB 的包拖下来
    expect(isMermaidMarker({ type: 'code-fence', from: 0, to: 1 })).toBe(false);
  });

  it('isMermaidLanguage 与 code-block / projection 的判定同源（大小写 + trim）', () => {
    // CommonMark 会 trim info string，` ``` mermaid ` 是合法写法。
    // 这三处若各写一遍，就会各自漏掉一种写法。
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage('MERMAID')).toBe(true);
    expect(isMermaidLanguage('  Mermaid  ')).toBe(true);
    expect(isMermaidLanguage('mermaid ')).toBe(true);
    expect(isMermaidLanguage('')).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
    expect(isMermaidLanguage('mermaidx')).toBe(false);
  });
});

describe('ExtensionHost lazy loading', () => {
  it('登记后谓词立刻生效，但不 import 扩展包', () => {
    const host = new ExtensionHost();
    const { loader } = makeLoader(MATH_EXTENSION_ID, isMathMarker);
    host.registerLazy(loader);

    expect(host.getHandler(inlineMath)).toBeDefined();
    expect(host.getHandler(blockMath)).toBeDefined();
    expect(host.getHandler({ type: 'wikilink', from: 0, to: 1 })).toBeUndefined();
    expect(loader.load).not.toHaveBeenCalled();
    expect(host.requestedIds()).toEqual([]);
    expect(host.loadedIds()).toEqual([]);
  });

  it('首次 load() 才 import，重复与并发 load() 只 import 一次', async () => {
    const host = new ExtensionHost();
    const { loader } = makeLoader(MATH_EXTENSION_ID, isMathMarker);
    host.registerLazy(loader);
    const handler = host.getHandler(inlineMath)!;

    const first = handler.load();
    const second = handler.load();
    await Promise.all([first, second]);
    await handler.load();

    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(host.requestedIds()).toEqual([MATH_EXTENSION_ID]);
    expect(host.loadedIds()).toEqual([MATH_EXTENSION_ID]);
  });

  it('load() 失败不缓存，重试会重新 import', async () => {
    const host = new ExtensionHost();
    const inner = makeInner(MATH_EXTENSION_ID, isMathMarker);
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk 拉取失败'))
      .mockResolvedValueOnce(inner);
    host.registerLazy({ id: MATH_EXTENSION_ID, matches: isMathMarker, load });
    const handler = host.getHandler(inlineMath)!;

    await expect(handler.load()).rejects.toThrow('chunk 拉取失败');
    // 失败后仍算「请求过」：错误 UI 上的重试按钮点了要在指标上留下痕迹
    expect(host.requestedIds()).toEqual([MATH_EXTENSION_ID]);
    expect(host.loadedIds()).toEqual([]);

    await handler.load();
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.loadedIds()).toEqual([MATH_EXTENSION_ID]);
  });

  it('load() 未解决前 activate() 抛错，解决后委派给真实扩展', async () => {
    const host = new ExtensionHost();
    let resolveLoad!: (ext: EditorExtension) => void;
    const load = vi.fn(() => new Promise<EditorExtension>((res) => { resolveLoad = res; }));
    host.registerLazy({ id: MATH_EXTENSION_ID, matches: isMathMarker, load });
    const handler = host.getHandler(inlineMath)!;

    const container = document.createElement('div');
    const pending = handler.load();
    expect(() => handler.activate(inlineMath, container, 'x')).toThrow(
      /activated before its load\(\) resolved/
    );

    resolveLoad(makeInner(MATH_EXTENSION_ID, isMathMarker));
    await pending;
    handler.activate(inlineMath, container, 'E=mc^2');
    expect(container.textContent).toBe(`${MATH_EXTENSION_ID}:E=mc^2`);
  });

  it('多个懒加载扩展互不牵连：只有命中的那个被 import', async () => {
    const host = new ExtensionHost();
    const math = makeLoader(MATH_EXTENSION_ID, isMathMarker);
    const mermaid = makeLoader(MERMAID_EXTENSION_ID, isMermaidMarker);
    host.registerLazy(math.loader);
    host.registerLazy(mermaid.loader);

    await host.getHandler(mermaidFence)!.load();

    expect(math.loader.load).not.toHaveBeenCalled();
    expect(host.requestedIds()).toEqual([MERMAID_EXTENSION_ID]);
    expect(host.loadedIds()).toEqual([MERMAID_EXTENSION_ID]);
  });

  it('mountExtension 先渲染 Loading，import 完成后原地 activate', async () => {
    const host = new ExtensionHost();
    let resolveLoad!: (ext: EditorExtension) => void;
    const load = vi.fn(() => new Promise<EditorExtension>((res) => { resolveLoad = res; }));
    host.registerLazy({ id: MATH_EXTENSION_ID, matches: isMathMarker, load });

    const container = document.createElement('div');
    const fallback = vi.fn();
    mountExtension(host, inlineMath, container, 'E=mc^2', fallback, undefined, 'zh-CN');

    expect(fallback).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('nexus-ext-loading');
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad(makeInner(MATH_EXTENSION_ID, isMathMarker));
    await new Promise((r) => setTimeout(r, 0));

    expect(container.textContent).toBe(`${MATH_EXTENSION_ID}:E=mc^2`);
  });
});

/**
 * 状态订阅。
 *
 * 存在的理由：`listExtensions()` 是**拉**模型，而扩展包是在用户看不见的时候加载完的
 * （投影挂载那条路）。没有通知的话，插件面板只能靠借别人的刷新信号碰运气 ——
 * 从加载完成到下一次编辑之间，面板会一直停在「加载中」。
 *
 * 三条判据：**通知推迟到下一拍**（`React.lazy` 的工厂在渲染过程中跑，同步通知会撞上
 * 「渲染期间更新」）、**送达时状态位已经翻转**（否则订阅方读到旧值）、
 * **退订之后不再被叫醒**（否则是泄漏，症状是「面板闪烁」这类难查的问题）。
 */
describe('ExtensionHost 状态订阅', () => {
  it('通知推迟到下一拍，送达时状态位已经翻转', async () => {
    const host = new ExtensionHost();
    const { loader } = makeLoader(MATH_EXTENSION_ID, isMathMarker);
    host.registerLazy(loader);

    // 回调里**重新读一遍 host**，而不是记下「通知来了」—— 要验的正是
    // 「送达时读到的是新值」。若通知发在位翻转之前，记下的就会是旧状态。
    const seen: string[] = [];
    host.subscribe(() => {
      seen.push(host.listExtensions().find((e) => e.id === MATH_EXTENSION_ID)!.state);
    });

    const pending = host.getHandler(inlineMath)!.load();

    // 推迟：此刻回调一次都还没跑（`queueMicrotask` 排下的那拍要等同步代码走完）
    expect(seen).toEqual([]);
    expect(host.revision).toBe(0);

    await pending;
    await new Promise((r) => setTimeout(r, 0));

    // 中间态也要报出来 —— 否则面板上的「加载中」永远不会出现
    expect(seen).toContain('loading');
    // 最后送达的一拍必须是终态
    expect(seen.at(-1)).toBe('loaded');
    expect(host.revision).toBeGreaterThan(0);
  });

  it('加载失败也会通知 —— 否则面板永远停在「加载中」', async () => {
    const host = new ExtensionHost();
    host.registerLazy({
      id: MATH_EXTENSION_ID,
      matches: isMathMarker,
      load: vi.fn().mockRejectedValue(new Error('chunk 拉取失败'))
    });

    const seen: string[] = [];
    host.subscribe(() => {
      seen.push(host.listExtensions().find((e) => e.id === MATH_EXTENSION_ID)!.state);
    });

    await expect(host.getHandler(inlineMath)!.load()).rejects.toThrow('chunk 拉取失败');
    await new Promise((r) => setTimeout(r, 0));

    expect(seen.at(-1)).toBe('failed');
  });

  it('退订之后不再被叫醒 —— 反面判据：不解除就是泄漏', async () => {
    const host = new ExtensionHost();
    const { loader } = makeLoader(MATH_EXTENSION_ID, isMathMarker);
    host.registerLazy(loader);

    const listener = vi.fn();
    host.subscribe(listener)();

    await host.getHandler(inlineMath)!.load();
    await new Promise((r) => setTimeout(r, 0));

    expect(listener).not.toHaveBeenCalled();
    // 但状态照常推进：退订只影响「谁被叫醒」，不影响记账
    expect(host.loadedIds()).toEqual([MATH_EXTENSION_ID]);
  });
});
