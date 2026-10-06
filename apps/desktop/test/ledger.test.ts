import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConcordLedger } from '../electron/ledger.js';

/**
 * 账本是**缓存**，所以这一组用例的重点不是「功能对不对」，而是**坏掉时会不会装成好的** ——
 * 每一个异常路径都必须安静地退化成 `null`（调用方据此降级为两路对齐）。
 */
describe('共同祖先账本', () => {
  let dir: string;
  let ledger: ConcordLedger;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexus-ledger-'));
    ledger = new ConcordLedger(path.join(dir, 'ledger'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('记下再取回，内容逐字相同', async () => {
    ledger.record('notes/a.md', '# 标题\n\n正文。\n');
    await ledger.flush();
    expect(ledger.getBase('notes/a.md')).toBe('# 标题\n\n正文。\n');
  });

  it('没记过的路径 → null（不是空串）', () => {
    expect(ledger.getBase('notes/never.md')).toBeNull();
  });

  it('空内容也能记 —— 空文档有祖先，就是空', async () => {
    ledger.record('notes/empty.md', '');
    await ledger.flush();
    expect(ledger.getBase('notes/empty.md')).toBe('');
  });

  it('后一次保存覆盖前一次', async () => {
    ledger.record('notes/a.md', '第一版');
    await ledger.flush();
    ledger.record('notes/a.md', '第二版');
    await ledger.flush();
    expect(ledger.getBase('notes/a.md')).toBe('第二版');
  });

  it('同一份内容只落一份 blob（改回去又改回来不堆副本）', async () => {
    ledger.record('notes/a.md', '同样的内容');
    await ledger.flush();
    ledger.record('notes/b.md', '同样的内容');
    await ledger.flush();

    const blobs = await fs.promises.readdir(path.join(dir, 'ledger', 'blobs'));
    expect(blobs).toHaveLength(1);
    expect(ledger.getBase('notes/a.md')).toBe('同样的内容');
    expect(ledger.getBase('notes/b.md')).toBe('同样的内容');
  });

  it('内容换掉之后，没人引用的旧 blob 被回收', async () => {
    ledger.record('notes/a.md', '旧内容');
    await ledger.flush();
    ledger.record('notes/a.md', '新内容');
    await ledger.flush();

    const blobs = await fs.promises.readdir(path.join(dir, 'ledger', 'blobs'));
    expect(blobs).toHaveLength(1);
    expect(ledger.getBase('notes/a.md')).toBe('新内容');
  });

  it('旧内容仍被别的文档引用时不回收', async () => {
    ledger.record('notes/a.md', '共享内容');
    ledger.record('notes/b.md', '共享内容');
    await ledger.flush();
    // a 改成别的，b 还指着旧 blob
    ledger.record('notes/a.md', '只有 a 的新内容');
    await ledger.flush();

    const blobs = await fs.promises.readdir(path.join(dir, 'ledger', 'blobs'));
    expect(blobs).toHaveLength(2);
    expect(ledger.getBase('notes/b.md')).toBe('共享内容');
  });

  it('forget 之后取不到，且 blob 被回收', async () => {
    ledger.record('notes/a.md', '要删的');
    await ledger.flush();
    ledger.forget('notes/a.md');
    await ledger.flush();

    expect(ledger.getBase('notes/a.md')).toBeNull();
    const blobs = await fs.promises.readdir(path.join(dir, 'ledger', 'blobs'));
    expect(blobs).toHaveLength(0);
  });

  it('forget 一个没记过的路径不抛错', async () => {
    ledger.forget('notes/never.md');
    await ledger.flush();
    expect(ledger.getBase('notes/never.md')).toBeNull();
  });

  it('rename 把条目搬到新键上，blob 原样不动', async () => {
    ledger.record('notes/old.md', '内容');
    await ledger.flush();
    ledger.rename('notes/old.md', 'notes/new.md');
    await ledger.flush();

    expect(ledger.getBase('notes/old.md')).toBeNull();
    expect(ledger.getBase('notes/new.md')).toBe('内容');
    // 改名不改内容 —— blob 不该被回收（它还指着同一份）
    const blobs = await fs.promises.readdir(path.join(dir, 'ledger', 'blobs'));
    expect(blobs).toHaveLength(1);
  });

  it('rename 一个没记过的路径不抛错，也不产生条目', async () => {
    ledger.rename('notes/never.md', 'notes/other.md');
    await ledger.flush();
    expect(ledger.getBase('notes/other.md')).toBeNull();
  });

  it('blob 被外部改坏 → 当没有，不返回坏内容', async () => {
    ledger.record('notes/a.md', '原文');
    await ledger.flush();

    const blobsDir = path.join(dir, 'ledger', 'blobs');
    const [name] = await fs.promises.readdir(blobsDir);
    await fs.promises.writeFile(path.join(blobsDir, name!), '被篡改的内容', 'utf8');

    expect(ledger.getBase('notes/a.md')).toBeNull();
  });

  it('blob 被删掉 → 当没有', async () => {
    ledger.record('notes/a.md', '原文');
    await ledger.flush();

    const blobsDir = path.join(dir, 'ledger', 'blobs');
    for (const name of await fs.promises.readdir(blobsDir)) {
      await fs.promises.rm(path.join(blobsDir, name));
    }
    expect(ledger.getBase('notes/a.md')).toBeNull();
  });

  it('索引不是 JSON → 当空账本，不抛错', async () => {
    ledger.record('notes/a.md', '原文');
    await ledger.flush();
    await fs.promises.writeFile(path.join(dir, 'ledger', 'index.json'), '这不是 JSON{{{', 'utf8');

    expect(ledger.getBase('notes/a.md')).toBeNull();
    // 还能继续记新的 —— 缓存坏了不该让功能停摆
    ledger.record('notes/b.md', '新内容');
    await ledger.flush();
    expect(ledger.getBase('notes/b.md')).toBe('新内容');
  });

  it('索引版本对不上 → 当空账本', async () => {
    ledger.record('notes/a.md', '原文');
    await ledger.flush();
    await fs.promises.writeFile(
      path.join(dir, 'ledger', 'index.json'),
      JSON.stringify({ version: 99, entries: { 'notes/a.md': { hash: 'x', at: 0 } } }),
      'utf8'
    );
    expect(ledger.getBase('notes/a.md')).toBeNull();
  });

  it('目录还不存在时取 → null，不抛错', () => {
    expect(new ConcordLedger(path.join(dir, '不存在的目录')).getBase('a.md')).toBeNull();
  });

  it('并发 record 不会把索引写坏', async () => {
    for (let i = 0; i < 20; i += 1) {
      ledger.record(`notes/${i}.md`, `第 ${i} 篇的内容`);
    }
    await ledger.flush();

    for (let i = 0; i < 20; i += 1) {
      expect(ledger.getBase(`notes/${i}.md`)).toBe(`第 ${i} 篇的内容`);
    }
    // 索引仍然可解析
    const raw = await fs.promises.readFile(path.join(dir, 'ledger', 'index.json'), 'utf8');
    expect(JSON.parse(raw).entries).toBeTypeOf('object');
  });

  it('CRLF 内容逐字保真（祖先必须与磁盘一致，不能归一化）', async () => {
    const crlf = '# 标题\r\n\r\n正文。\r\n';
    ledger.record('notes/crlf.md', crlf);
    await ledger.flush();
    expect(ledger.getBase('notes/crlf.md')).toBe(crlf);
  });
});
