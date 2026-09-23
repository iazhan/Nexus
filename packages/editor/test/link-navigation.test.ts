// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  MarkdownDocumentSession,
  createSessionEditorView,
  resolveRelativePath,
  type LinkNavigationRequest,
  type SessionEditorViewHandle
} from '../src/index.js';

describe('resolveRelativePath', () => {
  it('resolves ./ and bare relative links against the document directory', () => {
    const dir = 'D:\\Projects\\Codex\\Nexus\\docs';
    expect(resolveRelativePath(dir, './README.md')).toBe('D:\\Projects\\Codex\\Nexus\\docs\\README.md');
    expect(resolveRelativePath(dir, 'README.md')).toBe('D:\\Projects\\Codex\\Nexus\\docs\\README.md');
    expect(resolveRelativePath(dir, './assets/nexus-logo.png')).toBe(
      'D:\\Projects\\Codex\\Nexus\\docs\\assets\\nexus-logo.png'
    );
  });

  it('collapses ../ and . segments', () => {
    const dir = 'D:\\Projects\\Codex\\Nexus\\docs';
    expect(resolveRelativePath(dir, '../AGENTS.md')).toBe('D:\\Projects\\Codex\\Nexus\\AGENTS.md');
    expect(resolveRelativePath(dir, '../docs/./a/../b.md')).toBe(
      'D:\\Projects\\Codex\\Nexus\\docs\\b.md'
    );
  });

  it('keeps POSIX paths POSIX and preserves the leading slash', () => {
    expect(resolveRelativePath('/home/azhan/docs', './a/b.md')).toBe('/home/azhan/docs/a/b.md');
    expect(resolveRelativePath('/home/azhan/docs', '../x.md')).toBe('/home/azhan/x.md');
  });

  it('drops #fragment and ?query, which carry no meaning in a filesystem path', () => {
    expect(resolveRelativePath('D:\\docs', './guide.md#setup')).toBe('D:\\docs\\guide.md');
    expect(resolveRelativePath('D:\\docs', './guide.md?v=2')).toBe('D:\\docs\\guide.md');
  });

  it('returns null instead of guessing when the path escapes the root', () => {
    expect(resolveRelativePath('D:\\docs', '../../../etc/passwd')).toBeNull();
    expect(resolveRelativePath('/docs', '../../x.md')).toBeNull();
  });

  it('returns null for empty, fragment-only and query-only hrefs', () => {
    expect(resolveRelativePath('D:\\docs', '')).toBeNull();
    expect(resolveRelativePath('D:\\docs', '#anchor')).toBeNull();
    expect(resolveRelativePath('D:\\docs', '?q=1')).toBeNull();
  });

  it('treats a leading slash as relative to the document directory', () => {
    // 本编辑器没有"仓库根"的概念。解释成文档目录下，比静默失败更贴近用户预期，
    // 而且不会越过文档所在目录之外。
    expect(resolveRelativePath('D:\\docs', '/notes/x.md')).toBe('D:\\docs\\notes\\x.md');
  });
});

interface Probe {
  handle: SessionEditorViewHandle;
  /** 扩展处理完、CodeMirror 介入之前那一刻的 defaultPrevented。 */
  wasPrevented: () => boolean;
}

function mountVisual(
  source: string,
  navigator?: (request: LinkNavigationRequest) => boolean | void
): Probe {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const session = new MarkdownDocumentSession(source);
  const handle = createSessionEditorView({
    parent,
    session,
    surfaceId: `link-nav-${Math.random().toString(36).slice(2, 9)}`,
    surfaceKind: 'visual',
    ...(navigator ? { linkNavigator: navigator } : {})
  });

  // CodeMirror 自己也会在 mousedown 上 preventDefault（它要接管选区），所以事件派发结束后
  // 从外部读 defaultPrevented 分不清是谁吞的。这里在 view.dom 的捕获阶段补一个探针：
  // 注册顺序排在扩展之后、内容 DOM 的冒泡处理之前，读到的正好是"扩展处理完、CM 还没介入"。
  let prevented = false;
  handle.view.dom.addEventListener(
    'mousedown',
    (event) => {
      prevented = event.defaultPrevented;
    },
    true
  );

  return { handle, wasPrevented: () => prevented };
}

function dispatchMouseDown(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })
  );
}

function linkElement(probe: Probe, selector = '.cm-visual-link'): HTMLElement {
  const el = probe.handle.view.dom.querySelector(selector);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('Ctrl/Cmd + 左键链接导航', () => {
  it('navigates on Ctrl+click and hands the sanitized href to the host', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('See [Nexus](https://nexus.dev) here.', (request) => {
      received.push(request);
      return true;
    });

    dispatchMouseDown(linkElement(probe), { ctrlKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]?.href).toBe('https://nexus.dev');
    expect(received[0]?.pos).toBeGreaterThanOrEqual(0);
    // 已处理：必须吞掉事件，否则 CodeMirror 会顺手把光标挪进链接文字
    expect(probe.wasPrevented()).toBe(true);

    probe.handle.destroy();
  });

  it('navigates on Meta+click too, so macOS Cmd+click works', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('[Nexus](https://nexus.dev)', (request) => {
      received.push(request);
      return true;
    });

    dispatchMouseDown(linkElement(probe), { metaKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]?.href).toBe('https://nexus.dev');
    expect(probe.wasPrevented()).toBe(true);
    probe.handle.destroy();
  });

  it('does nothing on a plain click, so the caret can land in the link text', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('[Nexus](https://nexus.dev)', (request) => {
      received.push(request);
      return true;
    });

    dispatchMouseDown(linkElement(probe));

    expect(received).toHaveLength(0);
    expect(probe.wasPrevented()).toBe(false);
    probe.handle.destroy();
  });

  it('does not swallow the event when the host declines to handle it', () => {
    const probe = mountVisual('[Nexus](https://nexus.dev)', () => false);

    dispatchMouseDown(linkElement(probe), { ctrlKey: true });

    expect(probe.wasPrevented()).toBe(false);
    probe.handle.destroy();
  });

  it('never navigates a blocked-protocol link', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('[x](javascript:alert(1))', (request) => {
      received.push(request);
      return true;
    });

    const blocked = linkElement(probe, '.cm-visual-link-blocked');
    expect(blocked.getAttribute('data-safe-href')).toBeNull();

    dispatchMouseDown(blocked, { ctrlKey: true });

    expect(received).toHaveLength(0);
    // 被拦截的链接保持"点击即落光标"，既不导航也不吞事件
    expect(probe.wasPrevented()).toBe(false);
    probe.handle.destroy();
  });

  it('stays out of the way while the user is extending a selection', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('[Nexus](https://nexus.dev)', (request) => {
      received.push(request);
      return true;
    });

    dispatchMouseDown(linkElement(probe), { ctrlKey: true, shiftKey: true });
    dispatchMouseDown(linkElement(probe), { ctrlKey: true, altKey: true });

    expect(received).toHaveLength(0);
    probe.handle.destroy();
  });

  it('is not installed when the host provides no navigator', () => {
    const probe = mountVisual('[Nexus](https://nexus.dev)');

    dispatchMouseDown(linkElement(probe), { ctrlKey: true });

    expect(probe.wasPrevented()).toBe(false);
    probe.handle.destroy();
  });

  it('navigates table-cell links, which carry a real href instead of data-safe-href', () => {
    // 表格是整块 widget，单元格内容由 widget 自己渲染成真 <a href>，
    // 不走 mark 装饰，所以拿不到 data-safe-href。这里守住那条 href 兜底路径。
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual(
      ['| 列 | 说明 |', '| --- | --- |', '| a | [文档](./README.md) |'].join('\n'),
      (request) => {
        received.push(request);
        return true;
      }
    );

    const cellLink = linkElement(probe);
    expect(cellLink.getAttribute('data-safe-href')).toBeNull();
    expect(cellLink.getAttribute('href')).toBe('./README.md');

    dispatchMouseDown(cellLink, { ctrlKey: true });

    expect(received).toHaveLength(1);
    expect(received[0]?.href).toBe('./README.md');
    expect(probe.wasPrevented()).toBe(true);
    probe.handle.destroy();
  });

  it('does not react to a right or middle button press', () => {
    const received: LinkNavigationRequest[] = [];
    const probe = mountVisual('[Nexus](https://nexus.dev)', (request) => {
      received.push(request);
      return true;
    });

    dispatchMouseDown(linkElement(probe), { ctrlKey: true, button: 1 });
    dispatchMouseDown(linkElement(probe), { ctrlKey: true, button: 2 });

    expect(received).toHaveLength(0);
    probe.handle.destroy();
  });
});
