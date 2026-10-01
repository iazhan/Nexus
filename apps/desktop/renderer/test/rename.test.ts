// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { EditorSaveState } from '@nexus/editor';
import { unsavedPaths, describeSkips } from '../src/workspace/rename.js';

/**
 * 改名流程里两个**纯判断**。
 *
 * 它们被抽出来的理由就是这一层：`App.tsx` 是两千行的组件文件，从测试里 import 它
 * 等于为了测一个过滤器把整个应用装起来。这里只喂数据、只看结果。
 *
 * 传的是「长得像文档」的最小对象（`filePath` + `saveState`），不是真的
 * `WorkspaceDocument` —— 那需要造一个 `MarkdownDocumentSession`，而这两个函数
 * 一个字都不会读到它。
 */

type Subject = { filePath: string | null; saveState: EditorSaveState };

/** `t` 打桩成「键名:参数」，这样断言的是**用了哪个键**，不是某一版译文。 */
const fakeT = (key: string, vars?: Record<string, string>): string =>
  `${key}:${vars?.count ?? ''}`;

describe('unsavedPaths：改名回写要跳过哪些文档', () => {
  it('四种「缓冲区与磁盘不同步」的保存态都进', () => {
    const documents: Subject[] = [
      { filePath: 'a.md', saveState: 'dirty' },
      { filePath: 'b.md', saveState: 'saving' },
      { filePath: 'c.md', saveState: 'error' },
      { filePath: 'd.md', saveState: 'external-changed' }
    ];

    expect(unsavedPaths(documents)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });

  it('同步的三种都不进：clean / saved / readonly', () => {
    const documents: Subject[] = [
      { filePath: 'a.md', saveState: 'clean' },
      { filePath: 'b.md', saveState: 'saved' },
      { filePath: 'c.md', saveState: 'readonly' }
    ];

    expect(unsavedPaths(documents)).toEqual([]);
  });

  /**
   * `deleted` 不在集合里：文件已经不在盘上，没有可回写的对象。
   * 把它算成「不能动」会让回执上多出一条用户无法理解的「1 篇文档有未保存的修改」。
   */
  it('deleted 不算未保存', () => {
    expect(unsavedPaths([{ filePath: 'a.md', saveState: 'deleted' }])).toEqual([]);
  });

  it('未命名的文档即使脏也交不出路径，不进列表', () => {
    const documents: Subject[] = [
      { filePath: null, saveState: 'dirty' },
      { filePath: 'b.md', saveState: 'dirty' }
    ];

    expect(unsavedPaths(documents)).toEqual(['b.md']);
  });

  it('空集合给空数组（主进程那一侧要的是数组，不是 undefined）', () => {
    expect(unsavedPaths([])).toEqual([]);
  });
});

describe('describeSkips：回执按原因归并', () => {
  it('没有跳过项就没有任何行', () => {
    expect(describeSkips([], fakeT)).toEqual([]);
  });

  it('同一原因归并成一行，count 是条数', () => {
    const lines = describeSkips(
      [
        { relativePath: 'a.md', reason: 'dirty' },
        { relativePath: 'b.md', reason: 'dirty' },
        { relativePath: 'c.md', reason: 'dirty' }
      ],
      fakeT
    );

    expect(lines).toEqual(['workspace.renameSkipDirty:3']);
  });

  it('顺序固定：dirty → changed → unresolved → failed，不跟着输入顺序走', () => {
    const lines = describeSkips(
      [
        { relativePath: 'd.md', reason: 'failed' },
        { relativePath: 'c.md', reason: 'unresolved', target: 'x' },
        { relativePath: 'b.md', reason: 'changed' },
        { relativePath: 'a.md', reason: 'dirty' }
      ],
      fakeT
    );

    expect(lines).toEqual([
      'workspace.renameSkipDirty:1',
      'workspace.renameSkipChanged:1',
      'workspace.renameSkipUnresolved:1',
      'workspace.renameSkipFailed:1'
    ]);
  });

  it('没出现的原因不画那一行（不写「0 篇」）', () => {
    const lines = describeSkips([{ relativePath: 'a.md', reason: 'changed' }], fakeT);

    expect(lines).toEqual(['workspace.renameSkipChanged:1']);
  });

  /**
   * `unresolved` 是**每处引用一条**（主进程逐 target push），所以三处就是 3 ——
   * 文案说的是「N 处引用」，两边的单位必须对得上。
   */
  it('unresolved 数的是引用处数，不是文档数', () => {
    const lines = describeSkips(
      [
        { relativePath: 'a.md', reason: 'unresolved', target: '[[x]]' },
        { relativePath: 'a.md', reason: 'unresolved', target: '[[y]]' },
        { relativePath: 'a.md', reason: 'unresolved', target: '[[z]]' }
      ],
      fakeT
    );

    expect(lines).toEqual(['workspace.renameSkipUnresolved:3']);
  });

  it('翻译函数按「键 + count」被调用，不自己拼句子', () => {
    const t = vi.fn(fakeT);
    describeSkips([{ relativePath: 'a.md', reason: 'failed' }], t);

    expect(t).toHaveBeenCalledWith('workspace.renameSkipFailed', { count: '1' });
  });
});
