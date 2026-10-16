import { describe, expect, it } from 'vitest';
import { rebaseRelativeReferences, relativeFromDirectory } from '../src/index.js';

/**
 * 「文档自己换了目录，里面的相对写法要跟着换基准」。
 *
 * 与 `rewriteAttachmentReferences` 是两件不同的事：那个改的是**指向**某个被搬走对象的引用
 * （住在别人的文档里），这个改的是**文档自己的出链**。搬一个文件时两件都要做。
 */
describe('rebaseRelativeReferences', () => {
  /** 简写：只关心新正文。 */
  function rebase(text: string, from: string, to: string): string {
    return rebaseRelativeReferences(text, from, to).text;
  }

  it('图片与链接按新目录重算，`..` 的层数跟着变', () => {
    const text = [
      '![Diagram](assets/diagram.png)',
      '[Reference](assets/Reference%20Doc.pdf)',
      '[Nested](../shared/data.csv?download=1#latest)'
    ].join('\n');

    expect(rebase(text, 'notes/daily.md', 'archive/daily.md')).toBe(
      [
        '![Diagram](../notes/assets/diagram.png)',
        '[Reference](../notes/assets/Reference%20Doc.pdf)',
        '[Nested](../shared/data.csv?download=1#latest)'
      ].join('\n')
    );
  });

  it('往浅处搬时 `../` 会减少', () => {
    // `a/b/c.md` 里的 `../../d.md` 解析成 `d.md`；从 `c.md` 的新家（根目录）看就是 `d.md`
    expect(rebase('[d](../../d.md)', 'a/b/c.md', 'c.md')).toBe('[d](d.md)');
  });

  it('往深处搬时 `../` 会增加', () => {
    // `d.md` 解析成 `d.md`；从 `x/y/` 看要退两层
    expect(rebase('[d](d.md)', 'c.md', 'x/y/c.md')).toBe('[d](../../d.md)');
  });

  it('同一目录内改名：一个字节都不动，且返回同一个字符串引用', () => {
    const text = '![a](assets/x.png) 见 [[dma]]';
    const result = rebaseRelativeReferences(text, 'notes/daily.md', 'notes/renamed.md');
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('外链 / 纯锚点 / 根相对 / 指向自己：一律不动', () => {
    const text = [
      '[Remote](https://example.test/file.pdf)',
      '[Protocol](//cdn.test/a.png)',
      '[Anchor](#section)',
      '[Root](/assets/root.png)',
      '[Self](daily.md#section)',
      '[Dot self](./daily.md)',
      '[Query](?preview=1)'
    ].join('\n');

    expect(rebase(text, 'notes/daily.md', 'archive/daily.md')).toBe(text);
  });

  it('大小写不同的自引用也认出来（Windows 上同一个文件）', () => {
    const text = '[Self](Daily.md)';
    expect(rebase(text, 'notes/daily.md', 'archive/daily.md')).toBe(text);
  });

  it('保留 `./` 前缀与百分号编码 —— 改的是指向，不是排版', () => {
    // 新路径本来就以 `../` 开头时不再加 `./`（`./../x` 只会更难读，与 `rewriteAttachmentTarget` 同一条）
    expect(rebase('[a](./assets/x.png)', 'notes/a.md', 'archive/a.md')).toBe(
      '[a](../notes/assets/x.png)'
    );
    // 新路径还在同一层里时才保得住 `./`
    expect(rebase('[y](./y.png)', 'a/deep/x.md', 'a/x.md')).toBe('[y](./deep/y.png)');
    expect(rebase('[a](assets/my%20logo.png)', 'notes/a.md', 'archive/a.md')).toBe(
      '[a](../notes/assets/my%20logo.png)'
    );
  });

  it('尖括号包裹原样保留', () => {
    // `[a](<my file.png>)` 的路径部分含空格 —— 重算之后仍然含空格，所以仍然要包裹
    expect(rebase('[a](<my file.png>)', 'notes/a.md', 'archive/a.md')).toBe(
      '[a](<../notes/my file.png>)'
    );
  });

  it('代码区里的引用不动', () => {
    const text = ['正文 ![a](assets/x.png)', '', '```md', '![b](assets/x.png)', '```', '尾 `[c](y.png)`'].join(
      '\n'
    );
    const result = rebaseRelativeReferences(text, 'notes/daily.md', 'archive/daily.md');
    expect(result.count).toBe(1);
    expect(result.text).toContain('```md\n![b](assets/x.png)\n```');
    expect(result.text).toContain('尾 `[c](y.png)`');
  });

  it('同批搬走的子树内部引用保持不变（`moves` 里带上了它们）', () => {
    // 搬目录时每个文件各调一次，但 `moves` 是**同一份**：`[b](b.md)` 指的 `notes/b.md`
    // 也搬成了 `archive/b.md`，所以从 `archive/a.md` 看它仍然是 `b.md`。
    const moves = [
      { from: 'notes/a.md', to: 'archive/a.md' },
      { from: 'notes/b.md', to: 'archive/b.md' },
      { from: 'notes/sub/c.md', to: 'archive/sub/c.md' }
    ];
    const text = '[b](b.md) 与 [c](sub/c.md)';
    const result = rebaseRelativeReferences(text, 'notes/a.md', 'archive/a.md', moves);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
  });

  it('漏传 `moves` 会把子树内部的互链改断 —— 这正是它存在的理由', () => {
    // 反向用例：同一个输入、不传 `moves`，`notes/b.md` 会被算成 `../notes/b.md`，
    // 而那个位置已经没有文件了。留着这条是为了让「为什么需要 `moves`」可执行。
    const text = '[b](b.md)';
    expect(rebaseRelativeReferences(text, 'notes/a.md', 'archive/a.md').text).toBe(
      '[b](../notes/b.md)'
    );
  });

  it('指向同批搬走的附件也要换到新家', () => {
    const moves = [
      { from: 'notes/a.md', to: 'archive/a.md' },
      { from: 'notes/assets/x.png', to: 'archive/assets/x.png' }
    ];
    const text = '![x](assets/x.png)';
    expect(rebaseRelativeReferences(text, 'notes/a.md', 'archive/a.md', moves).text).toBe(text);
  });

  it('没有引用要改时 text 与入参同一个引用（调用方可以拿 === 判断）', () => {
    const text = '没有引用的正文';
    expect(rebaseRelativeReferences(text, 'notes/a.md', 'archive/a.md').text).toBe(text);
  });

  it('HTML `<img src>` 也重算', () => {
    expect(rebase('<img src="assets/x.png" alt="x">', 'notes/a.md', 'archive/a.md')).toBe(
      '<img src="../notes/assets/x.png" alt="x">'
    );
  });

  it('引用式链接的定义行不在处理范围内（与索引器同一条口径）', () => {
    // `references.ts` 的 `REFERENCE_PATTERN` 不认 `[ref]: path`，索引器也不认。
    // 「扫得出的改得到、扫不出的漏掉」这条不变式比多覆盖一种写法重要。
    const text = '[ref]: assets/x.png';
    expect(rebase(text, 'notes/a.md', 'archive/a.md')).toBe(text);
  });
});

describe('relativeFromDirectory', () => {
  it('从目录到目标的相对路径', () => {
    expect(relativeFromDirectory('archive', 'notes/assets/x.png')).toBe('../notes/assets/x.png');
    expect(relativeFromDirectory('', 'notes/x.png')).toBe('notes/x.png');
    expect(relativeFromDirectory('a/b', 'a/b/c.md')).toBe('c.md');
  });

  it('目标是目录自己时返回 `null`（没有可写的相对路径）', () => {
    expect(relativeFromDirectory('notes', 'notes')).toBeNull();
    expect(relativeFromDirectory('', '')).toBeNull();
  });
});
