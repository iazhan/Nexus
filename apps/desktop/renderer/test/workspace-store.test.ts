import { describe, it, expect, vi } from 'vitest';
import { WorkspaceStore } from '../src/workspace/store.js';

/**
 * 工作区状态层（P2-04）。
 *
 * 这是纯逻辑，不碰 React —— 所以可以直接测「同一个文件被打开两次会怎样」
 * 这类真正会出事的分支，而不必先把它渲染出来。
 */
describe('WorkspaceStore', () => {
  it('初始状态为空', () => {
    const store = new WorkspaceStore();
    expect(store.getDocuments()).toEqual([]);
    expect(store.getActive()).toBeNull();
    expect(store.isEmpty).toBe(true);
  });

  it('打开文档会新建并激活它', () => {
    const store = new WorkspaceStore();
    const document = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });

    expect(store.getDocuments()).toHaveLength(1);
    expect(store.getActive()?.id).toBe(document.id);
    expect(store.getActive()?.filePath).toBe('/vault/a.md');
    expect(store.getActive()?.session.getSnapshot().source).toBe('# a\n');
    expect(store.isEmpty).toBe(false);
  });

  it('同一路径重复打开只激活既有标签页，不新建', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    const again = store.openDocument({ filePath: '/vault/a.md', content: '# 磁盘上的新内容\n' });

    expect(store.getDocuments()).toHaveLength(2);
    expect(again.id).toBe(first.id);
    expect(store.getActiveId()).toBe(first.id);
    // 关键：不能把磁盘内容灌进已打开的 session，那会丢掉用户未保存的编辑
    expect(again.session.getSnapshot().source).toBe('# a\n');
  });

  it('未命名文档各有独立身份，不会被当成同一个', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: null, content: '' });
    const second = store.openDocument({ filePath: null, content: '' });

    expect(store.getDocuments()).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
  });

  it('另存为换路径不换身份', () => {
    const store = new WorkspaceStore();
    const document = store.openDocument({ filePath: null, content: '# draft\n' });

    store.setActiveFilePath('/vault/saved.md');

    expect(store.getDocuments()).toHaveLength(1);
    expect(store.getActiveId()).toBe(document.id);
    expect(store.getActive()?.filePath).toBe('/vault/saved.md');
  });

  it('每份文档持有各自的 session，内容互不干扰', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    first.session.replaceSource('# a edited\n', { selection: { anchor: 0, head: 0 } });

    expect(first.session.getSnapshot().source).toBe('# a edited\n');
    expect(second.session.getSnapshot().source).toBe('# b\n');
  });

  it('激活切换只改 activeId', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    store.activate(first.id);
    expect(store.getActiveId()).toBe(first.id);
    expect(store.getDocuments()).toHaveLength(2);

    store.activate(second.id);
    expect(store.getActiveId()).toBe(second.id);
  });

  it('激活不存在的 id 是空操作', () => {
    const store = new WorkspaceStore();
    const document = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });

    store.activate('nope');

    expect(store.getActiveId()).toBe(document.id);
  });

  it('关闭活动标签页后激活右边那个', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });
    const third = store.openDocument({ filePath: '/vault/c.md', content: '# c\n' });

    store.activate(second.id);
    store.closeDocument(second.id);

    expect(store.getDocuments().map((d) => d.id)).toEqual([first.id, third.id]);
    expect(store.getActiveId()).toBe(third.id);
  });

  it('关闭最后一个标签页后激活左边那个', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    store.closeDocument(second.id);

    expect(store.getActiveId()).toBe(first.id);
  });

  it('关闭非活动标签页不影响当前活动文档', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    store.activate(second.id);
    store.closeDocument(first.id);

    expect(store.getActiveId()).toBe(second.id);
    expect(store.getDocuments()).toHaveLength(1);
  });

  it('关掉最后一个文档后工作区为空', () => {
    const store = new WorkspaceStore();
    const document = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });

    expect(store.closeDocument(document.id)).toBeNull();
    expect(store.getActive()).toBeNull();
    expect(store.isEmpty).toBe(true);
  });

  it('保存状态按文档隔离', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const second = store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    store.setSaveState(first.id, 'dirty');
    store.setSaveState(second.id, 'error', '磁盘只读');

    expect(first.saveState).toBe('dirty');
    expect(first.saveError).toBeNull();
    expect(second.saveState).toBe('error');
    expect(second.saveError).toBe('磁盘只读');
  });

  it('只读文档初始就是 readonly 状态', () => {
    const store = new WorkspaceStore();
    const document = store.openDocument({
      filePath: '/vault/locked.md',
      content: '# locked\n',
      readOnly: true
    });

    expect(document.saveState).toBe('readonly');
    expect(document.readOnly).toBe(true);
  });

  it('变更会通知订阅者，取消订阅后不再通知', () => {
    const store = new WorkspaceStore();
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('activate 被当作回调传出去时不丢 this', () => {
    const store = new WorkspaceStore();
    const first = store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    store.openDocument({ filePath: '/vault/b.md', content: '# b\n' });

    // 模拟 React 的用法：`onActivate={store.activate}` —— 方法被摘下来单独传递。
    // 如果 activate 写成普通方法，这里 `this` 就是 undefined，调用直接抛错；
    // 而异常发生在事件处理里，表现是「点了标签页没反应」，不报错也不留痕。
    const onActivate = store.activate;
    expect(() => onActivate(first.id)).not.toThrow();
    expect(store.getActiveId()).toBe(first.id);
  });

  it('snapshot 引用只在变更时变化', () => {
    const store = new WorkspaceStore();
    const before = store.getSnapshot();

    store.openDocument({ filePath: '/vault/a.md', content: '# a\n' });
    const afterOpen = store.getSnapshot();
    expect(afterOpen).not.toBe(before);

    // 无变更时反复读必须返回同一个引用，否则 useSyncExternalStore 会无限重渲染
    expect(store.getSnapshot()).toBe(afterOpen);

    // 激活已经是活动的文档也不该产生新 snapshot
    store.activate(store.getActiveId()!);
    expect(store.getSnapshot()).toBe(afterOpen);
  });
});
