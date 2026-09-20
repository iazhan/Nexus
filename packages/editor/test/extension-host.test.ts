// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { ExtensionHost, mountExtension, type EditorExtension, type EditorExtensionControl } from '../src/extensions.js';
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
