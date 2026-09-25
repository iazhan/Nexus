import { describe, it, expect } from 'vitest';
import { ExtensionHost, type EditorExtension, type ExtensionLoader } from '../src/extensions.js';

/** 静态注册用的最小扩展。 */
function staticExtension(id: string): EditorExtension {
  return {
    id,
    canHandle: () => false,
    load: async () => undefined,
    activate: () => ({ update: () => undefined, destroy: () => undefined })
  };
}

function lazyLoader(id: string, load: () => Promise<EditorExtension>): ExtensionLoader {
  return { id, matches: () => true, load };
}

/**
 * `ExtensionHost.listExtensions()` —— 插件面板的数据源。
 *
 * 重点是 `idle` 与 `failed` 的区分：失败后 `pending` 被清空（为了允许重试）、
 * `inner` 仍是 null，光看这两个字段和「还没触发过」一模一样。
 * 所以 `LazyExtension` 必须单独记一位失败标记，这里就是验证它真的被记上了。
 */
describe('扩展状态列表', () => {
  it('静态注册的扩展直接算已加载', () => {
    const host = new ExtensionHost();
    host.register(staticExtension('builtin'));

    expect(host.listExtensions()).toEqual([{ id: 'builtin', state: 'loaded' }]);
  });

  it('懒加载扩展在触发前是 idle —— 这是「没下载任何字节」的可见证据', () => {
    const host = new ExtensionHost();
    host.registerLazy(lazyLoader('lazy', async () => staticExtension('lazy')));

    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'idle' }]);
  });

  it('触发后、完成前是 loading', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const host = new ExtensionHost();
    host.registerLazy(
      lazyLoader('lazy', async () => {
        await gate;
        return staticExtension('lazy');
      })
    );

    const pending = host.getHandler({ type: 'math', from: 0, to: 1 } as never)!.load();

    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'loading' }]);

    release!();
    await pending;
    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'loaded' }]);
  });

  it('加载失败后是 failed，而不是退回 idle', async () => {
    const host = new ExtensionHost();
    host.registerLazy(
      lazyLoader('lazy', async () => {
        throw new Error('网络错误');
      })
    );

    await expect(
      host.getHandler({ type: 'math', from: 0, to: 1 } as never)!.load()
    ).rejects.toThrow('网络错误');

    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'failed' }]);
  });

  it('失败后重试成功，状态回到 loaded', async () => {
    let attempt = 0;
    const host = new ExtensionHost();
    host.registerLazy(
      lazyLoader('lazy', async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('第一次失败');
        return staticExtension('lazy');
      })
    );

    const handler = host.getHandler({ type: 'math', from: 0, to: 1 } as never)!;
    await expect(handler.load()).rejects.toThrow('第一次失败');
    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'failed' }]);

    await handler.load();
    expect(host.listExtensions()).toEqual([{ id: 'lazy', state: 'loaded' }]);
  });

  it('同时列出静态与懒加载扩展', () => {
    const host = new ExtensionHost();
    host.register(staticExtension('builtin'));
    host.registerLazy(lazyLoader('lazy', async () => staticExtension('lazy')));

    expect(host.listExtensions()).toEqual([
      { id: 'builtin', state: 'loaded' },
      { id: 'lazy', state: 'idle' }
    ]);
  });

  it('没有注册任何扩展时返回空数组', () => {
    expect(new ExtensionHost().listExtensions()).toEqual([]);
  });
});
