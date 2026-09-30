// @vitest-environment node

/**
 * 诊断信息（`electron/diagnostics.ts`）。
 *
 * 与 `index-path.ts` 同一条理由抽出来：它是「几个字符串进、一个对象出」的纯函数，
 * 唯一摸系统的地方是 `fs.statSync`。埋在 `electron/index.ts` 里的话，
 * 「文件不存在时给什么」这一条就只有真机跑得出来，而它恰好是这一项最容易写错的地方。
 *
 * 另一半（把这份数据拼成文本）在渲染进程，见 `renderer/test/diagnostics-format.test.ts`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDiagnostics, type DiagnosticsFacts } from '../electron/diagnostics.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-diagnostics-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const FACTS: DiagnosticsFacts = {
  version: '0.44.0',
  platform: 'win32',
  arch: 'x64',
  electron: '34.0.0',
  chromium: '132.0.6834.83',
  node: '20.18.0',
  workspaceRoot: null,
  indexDbPath: null
};

describe('诊断信息', () => {
  it('平台与架构拼成一段，读的人不用再对一次', () => {
    expect(buildDiagnostics(FACTS).platform).toBe('win32-x64');
  });

  it('没有工作区时工作区与索引两项都是 null —— 不是空串、不是空对象', () => {
    const report = buildDiagnostics(FACTS);

    expect(report.workspaceRoot).toBeNull();
    expect(report.index).toBeNull();
  });

  it('库文件存在时给出大小与修改时间（ISO 8601）', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, '9473eb44a1c2b3d4.db');
    fs.writeFileSync(dbPath, Buffer.alloc(2412544));

    const report = buildDiagnostics({ ...FACTS, workspaceRoot: dir, indexDbPath: dbPath });

    expect(report.workspaceRoot).toBe(dir);
    expect(report.index?.path).toBe(dbPath);
    expect(report.index?.sizeBytes).toBe(2412544);
    // ISO 且带时区：贴进 issue 之后不会因为「本机时间还是 UTC」而歧义。
    expect(report.index?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  /**
   * **这一条是「不打开索引库」那个决定的落点。**
   *
   * 拿文档数要 `new Database(path)`，而它会**创建**库文件 —— 用户点开设置页看一眼诊断，
   * 就凭空多出一个 `.db`。所以诊断只报告文件系统事实：文件不在，路径照给（它是工作区路径的
   * 纯函数），大小与时间留空。
   *
   * 判据里同时钉住「**没有**把文件建出来」：只断言返回 null 的话，一个「先 stat 失败再顺手
   * touch 一个空文件」的实现也能过。
   */
  it('库文件还不存在时：路径照给、大小与时间留空，而且**不创建**那个文件', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'never-built.db');

    const report = buildDiagnostics({ ...FACTS, workspaceRoot: dir, indexDbPath: dbPath });

    expect(report.index?.path).toBe(dbPath);
    expect(report.index?.sizeBytes).toBeNull();
    expect(report.index?.updatedAt).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('报告里不含文档内容 —— 它只有环境，没有作品', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'x.db');
    fs.writeFileSync(dbPath, Buffer.alloc(8));

    const keys = Object.keys(buildDiagnostics({ ...FACTS, workspaceRoot: dir, indexDbPath: dbPath }));

    expect(keys).toEqual([
      'version',
      'platform',
      'electron',
      'chromium',
      'node',
      'workspaceRoot',
      'index'
    ]);
  });
});
