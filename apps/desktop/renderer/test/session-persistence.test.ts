import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  clearSessionSnapshot,
  parseSessionSnapshot,
  readSessionSnapshot,
  sameWorkspaceRoot,
  serializeSessionSnapshot,
  writeSessionSnapshot,
  SESSION_TABS_STORAGE_KEY
} from '../src/workspace/session-persistence.js';

/**
 * 「上次开着的文档」的存档格式（2026-10-14）。
 *
 * 这一层是纯函数 + `localStorage` 读写，happy-dom 就够 —— 真正「恢复出标签页」的
 * 那一条链（快照 → `openFile` / `openViewerDocumentAt` → store）在渲染 `App` 的
 * `session-restore-app.test.tsx` 里验，那边才碰得到 IPC 桥。
 *
 * 判据集中在**坏值一律当没有**：这份文件用户改得动，而「半个快照」没有意义 ——
 * 接一半文档出来，比什么都不接更难解释。
 */

beforeEach(() => {
  localStorage.clear();
});

const GOOD = {
  root: 'D:/vault',
  entries: [
    { path: 'D:/vault/a.md', page: null },
    { path: 'D:/vault/manual.pdf', page: 7 }
  ],
  activePath: 'D:/vault/a.md'
};

describe('解析快照', () => {
  it('认得出完整的一份', () => {
    expect(parseSessionSnapshot(GOOD)).toEqual(GOOD);
  });

  it('坏 JSON / 非对象 / 空壳一律返回 null', () => {
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(parseSessionSnapshot('x')).toBeNull();
    expect(parseSessionSnapshot({})).toBeNull();
    // 缺 root 或缺 entries 都是「不是一份快照」
    expect(parseSessionSnapshot({ root: 'D:/vault' })).toBeNull();
    expect(parseSessionSnapshot({ entries: [] })).toBeNull();
  });

  it('条目逐条判：坏条目丢掉，好的留下', () => {
    const parsed = parseSessionSnapshot({
      root: 'D:/vault',
      entries: [
        { path: 'D:/vault/a.md', page: null },
        { path: '' }, // 空路径：没有路径就无从恢复
        null, // 整条不是对象
        'nope',
        { path: 'D:/vault/b.md', page: 3 }
      ],
      activePath: null
    });

    expect(parsed?.entries).toEqual([
      { path: 'D:/vault/a.md', page: null },
      { path: 'D:/vault/b.md', page: 3 }
    ]);
  });

  it('page 只认 ≥ 1 的整数；认不出的归 null', () => {
    const parsed = parseSessionSnapshot({
      root: 'D:/vault',
      entries: [
        { path: 'D:/vault/p.pdf', page: 0 },
        { path: 'D:/vault/q.pdf', page: 2.7 },
        { path: 'D:/vault/r.pdf', page: 'x' },
        { path: 'D:/vault/s.pdf', page: 4 }
      ],
      activePath: null
    });

    expect(parsed?.entries.map((entry) => entry.page)).toEqual([null, 2, null, 4]);
  });

  it('activePath 必须是其中一条；否则归 null', () => {
    // 指向一个已经被关掉的文档：激活那一步会静默落空（症状是「恢复了但高亮的是
    // 另一个」）。归 null 更诚实 —— 恢复完激活的是最后打开的那个。
    const parsed = parseSessionSnapshot({
      root: 'D:/vault',
      entries: [{ path: 'D:/vault/a.md', page: null }],
      activePath: 'D:/vault/closed.md'
    });

    expect(parsed?.activePath).toBeNull();
  });

  it('序列化再解析回来是同一份', () => {
    const parsed = parseSessionSnapshot(JSON.parse(serializeSessionSnapshot(GOOD)));
    expect(parsed).toEqual(GOOD);
  });
});

describe('同一个工作区根', () => {
  it('大小写（仅 Windows 盘符路径）与末尾分隔符不影响', () => {
    expect(sameWorkspaceRoot('D:/vault', 'd:\\vault')).toBe(true);
    expect(sameWorkspaceRoot('D:/vault/', 'D:/vault')).toBe(true);
    expect(sameWorkspaceRoot('D:/vault\\', 'd:/vault')).toBe(true);
  });

  it('不同目录就是不同，POSIX 路径不折大小写', () => {
    expect(sameWorkspaceRoot('D:/vault', 'D:/vault2')).toBe(false);
    expect(sameWorkspaceRoot('/home/me/Vault', '/home/me/vault')).toBe(false);
  });
});

describe('读盘 / 写盘', () => {
  it('没有存档时返回 null', () => {
    expect(readSessionSnapshot()).toBeNull();
  });

  it('写进去的读得回来', () => {
    writeSessionSnapshot(GOOD);
    expect(readSessionSnapshot()).toEqual(GOOD);
  });

  it('内容一模一样时不重复写（effect 挂在每次 store 变化上）', () => {
    writeSessionSnapshot(GOOD);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    writeSessionSnapshot(GOOD);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('存储里的坏 JSON 当没有', () => {
    localStorage.setItem(SESSION_TABS_STORAGE_KEY, '{ 这不是 JSON');
    expect(readSessionSnapshot()).toBeNull();
  });

  it('清掉之后读不到', () => {
    writeSessionSnapshot(GOOD);
    clearSessionSnapshot();
    expect(readSessionSnapshot()).toBeNull();
  });
});
