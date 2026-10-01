// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveWikiLink } from '@nexus/core';
import { FileService } from '../electron/file-service.js';
import { IndexStore } from '../electron/index-store.js';
import { indexWorkspace } from '../electron/indexer.js';

/**
 * P2-09 收官验收第二条：移动和重命名不会破坏可解析链接（蓝图 §10.2）。
 *
 * 这条不变量由两个已单独验证的事实组合保证：
 *   1. 索引可重建 —— `index-store.test.ts` 的「可重建性」块（第一条验收）
 *   2. `resolveWikiLink` 是无状态纯函数，每次拿当前文档列表解析、不缓存、
 *      不写回原文
 *
 * 本文件补的是**组合层的显式断言**：文件移动/重命名后，重新扫盘更新索引，
 * 链接解析结果跟着走，而用户 Markdown 里的 `[[...]]` 一个字都不被改写。
 *
 * 这是 Phase 2 的收官验收之一 —— 它把「链接解析不改原文」这条架构不变量
 * 变成可执行的断言。
 *
 * **注意这条不变量的主语是 Resolver，不是「永远没人改」。** 用户显式发起的重命名
 * **会**改写引用（批二加的引用回写，见 `rename-file.test.ts` 与
 * `docs/rename-and-link-rewrite-proposal.md`）。本文件里的移动用的是裸
 * `fsPromises.rename`，走的不是那条流程 —— 这正是它能断言「一个字都没被改写」的原因。
 * 别把它读成「任何情况下 `[[...]]` 都不许改」。
 */
describe('P2-09 验收：移动/重命名不破坏可解析链接', () => {
  let tempDir: string;
  let workspace: string;
  let dbPath: string;
  let service: FileService;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-p2-09-'));
    workspace = path.join(tempDir, 'vault');
    await fsPromises.mkdir(workspace, { recursive: true });
    dbPath = path.join(tempDir, 'index.db');

    service = new FileService();
    await service.authorizeWorkspace(workspace);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  const writeDoc = async (relativePath: string, content: string): Promise<string> => {
    const absolute = path.join(workspace, relativePath);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf-8');
    return absolute;
  };

  it('文件移动到子目录后，[[target]] 仍可解析且指向新路径；原文不被改写', async () => {
    const rootContent = '# 根\n\n链接到 [[target]]。\n';
    await writeDoc('root.md', rootContent);
    await writeDoc('target.md', '# 目标\n\n内容。\n');

    // 建索引
    let store = IndexStore.open(dbPath);
    await indexWorkspace({ service, store, rootPath: workspace });

    // 移动前：[[target]] 按文件名解析到根目录的 target.md
    let res = resolveWikiLink('target', store.listDocuments());
    expect(res.status).toBe('resolved');
    expect(res.document?.relativePath).toBe('target.md');
    store.close();

    // 移动 target.md → notes/target.md（文件名没变，目录变了）
    await fsPromises.mkdir(path.join(workspace, 'notes'), { recursive: true });
    await fsPromises.rename(
      path.join(workspace, 'target.md'),
      path.join(workspace, 'notes', 'target.md')
    );

    // 重新扫盘 —— indexWorkspace 会清掉旧的 target.md 条目（扫描未截断时删 stale）
    store = IndexStore.open(dbPath);
    await indexWorkspace({ service, store, rootPath: workspace });

    // 移动后：[[target]] 仍 resolved，但指向新路径
    res = resolveWikiLink('target', store.listDocuments());
    expect(res.status).toBe('resolved');
    expect(res.document?.relativePath).toBe('notes/target.md');
    store.close();

    // 关键：原文里的 [[target]] 没被改写（蓝图 §10.2：Resolver 重新解析，不重写用户 Markdown）
    expect(await fsPromises.readFile(path.join(workspace, 'root.md'), 'utf-8')).toBe(rootContent);
  });

  it('重命名文件后，旧名链接变 not-found、新名链接 resolved；原文不被改写', async () => {
    const rootContent = '# 根\n\n链接到 [[target]] 和 [[renamed]]。\n';
    await writeDoc('root.md', rootContent);
    await writeDoc('target.md', '# 目标\n');

    let store = IndexStore.open(dbPath);
    await indexWorkspace({ service, store, rootPath: workspace });

    // 重命名前：[[target]] resolved、[[renamed]] not-found（文件还不存在）
    expect(resolveWikiLink('target', store.listDocuments()).status).toBe('resolved');
    expect(resolveWikiLink('renamed', store.listDocuments()).status).toBe('not-found');
    store.close();

    // 重命名 target.md → renamed.md（文件名变了）
    await fsPromises.rename(
      path.join(workspace, 'target.md'),
      path.join(workspace, 'renamed.md')
    );

    store = IndexStore.open(dbPath);
    await indexWorkspace({ service, store, rootPath: workspace });

    // 重命名后：[[target]] 变 not-found（旧名找不到了）、[[renamed]] resolved（新名能找到）
    expect(resolveWikiLink('target', store.listDocuments()).status).toBe('not-found');
    const res = resolveWikiLink('renamed', store.listDocuments());
    expect(res.status).toBe('resolved');
    expect(res.document?.relativePath).toBe('renamed.md');
    store.close();

    // 原文没被改写 —— Resolver 不会去把 [[target]] 改成 [[renamed]]
    expect(await fsPromises.readFile(path.join(workspace, 'root.md'), 'utf-8')).toBe(rootContent);
  });
});
