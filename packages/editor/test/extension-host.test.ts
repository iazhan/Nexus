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
    expect(container.textContent).toContain('Extension unavailable: mock-fail');
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
