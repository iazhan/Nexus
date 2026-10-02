// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LAUNCH_CONTEXT, type LaunchContext } from '@nexus/core';
import {
  applyRecentWorkspace,
  EMPTY_RECENT_WORKSPACE,
  parseRecentWorkspace,
  readRecentWorkspace,
  recentWorkspacePath,
  writeRecentWorkspace
} from '../electron/recent-workspace.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 「上次打开的工作区」的落盘与启动回落。
 *
 * 为什么这一层能在**不启动 Electron** 的前提下把行为测全：模块收的是**目录**而不是
 * 自己去问 `app.getPath('userData')`，所以一个临时目录就是完整的运行环境。
 * 主进程那边只负责把路径传进来。
 *
 * 这一层的重点是**失败方向**：恢复一个工作区等于对那个目录做一次授权（写权限），
 * 所以下面有一整组「坏值一律不恢复」的用例。
 */

const workspace = 'D:/notes/vault';
const alwaysDirectory = (): boolean => true;
const neverDirectory = (): boolean => false;

function context(patch: Partial<LaunchContext> = {}): LaunchContext {
  return { ...DEFAULT_LAUNCH_CONTEXT, ...patch };
}

describe('最近工作区 · 落盘', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-recent-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('没记过时读到空状态 —— 文件不存在不是错误', () => {
    expect(readRecentWorkspace(directory)).toEqual(EMPTY_RECENT_WORKSPACE);
    expect(fs.existsSync(recentWorkspacePath(directory))).toBe(false);
  });

  it('写进去再读回来是同一份', () => {
    writeRecentWorkspace(directory, { restoreLastWorkspace: true, workspaceRoot: workspace });

    expect(readRecentWorkspace(directory)).toEqual({
      restoreLastWorkspace: true,
      workspaceRoot: workspace
    });
  });

  it('目录还不存在时会建出来 —— 首次运行时 userData 可能刚被清过', () => {
    const nested = path.join(directory, 'a', 'b');

    writeRecentWorkspace(nested, { restoreLastWorkspace: false, workspaceRoot: workspace });

    expect(readRecentWorkspace(nested).workspaceRoot).toBe(workspace);
  });

  it('文件是坏 JSON 时读到空状态，不抛', () => {
    fs.writeFileSync(recentWorkspacePath(directory), '{ 这不是 JSON', 'utf8');

    expect(readRecentWorkspace(directory)).toEqual(EMPTY_RECENT_WORKSPACE);
  });

  it('文件是合法 JSON 但不是对象时读到空状态', () => {
    fs.writeFileSync(recentWorkspacePath(directory), '"just a string"', 'utf8');

    expect(readRecentWorkspace(directory)).toEqual(EMPTY_RECENT_WORKSPACE);
  });

  /**
   * 这一组盯的是「写坏的存档」这个方向。开关与目录的判据**不同**：
   * 开关回落到这一项的默认值（开），目录则一律当作「没记过」—— 后者才是那张写权限。
   */
  it('目录字段类型不对时按「没记过目录」处理 —— 不恢复那个目录', () => {
    fs.writeFileSync(
      recentWorkspacePath(directory),
      JSON.stringify({ restoreLastWorkspace: 'true', workspaceRoot: 42 }),
      'utf8'
    );

    expect(readRecentWorkspace(directory)).toEqual(EMPTY_RECENT_WORKSPACE);
  });

  it('恢复开关是坏值时按默认（开）走，不静默失效', () => {
    expect(
      parseRecentWorkspace({ restoreLastWorkspace: 'yes', workspaceRoot: workspace })
    ).toEqual({
      restoreLastWorkspace: true,
      workspaceRoot: workspace
    });
  });

  it('空串的工作区路径按「没记过」处理，不是一个路径', () => {
    // `fs.statSync('')` 在各平台上的行为不一致，不该让它走到判目录那一步。
    expect(parseRecentWorkspace({ restoreLastWorkspace: true, workspaceRoot: '   ' })).toEqual({
      restoreLastWorkspace: true,
      workspaceRoot: null
    });
  });

  it('只有显式 false 才算关着', () => {
    expect(parseRecentWorkspace({ restoreLastWorkspace: 1 }).restoreLastWorkspace).toBe(true);
    expect(parseRecentWorkspace({ restoreLastWorkspace: null }).restoreLastWorkspace).toBe(true);
    expect(parseRecentWorkspace({}).restoreLastWorkspace).toBe(true);
    expect(parseRecentWorkspace({ restoreLastWorkspace: true }).restoreLastWorkspace).toBe(true);
    expect(parseRecentWorkspace({ restoreLastWorkspace: false }).restoreLastWorkspace).toBe(false);
  });
});

describe('最近工作区 · 启动回落', () => {
  const on: { restoreLastWorkspace: boolean; workspaceRoot: string | null } = {
    restoreLastWorkspace: true,
    workspaceRoot: workspace
  };

  it('设置开着 + 目录还在 → 进工作区模式', () => {
    const result = applyRecentWorkspace(context(), on, alwaysDirectory);

    expect(result.mode).toBe('workspace');
    expect(result.workspaceRoot).toBe(workspace);
    expect(result.filePath).toBeNull();
  });

  it('设置关着 → 一动不动（不自动接手，由欢迎态让用户自己选）', () => {
    const result = applyRecentWorkspace(
      context(),
      { restoreLastWorkspace: false, workspaceRoot: workspace },
      alwaysDirectory
    );

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  it('没记过目录 → 一动不动', () => {
    const result = applyRecentWorkspace(
      context(),
      { restoreLastWorkspace: true, workspaceRoot: null },
      alwaysDirectory
    );

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  it('目录已经不在了（被删 / 被改名）→ 一动不动，而不是进一个空工作区', () => {
    const result = applyRecentWorkspace(context(), on, neverDirectory);

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  it('显式给了一个 Markdown 文件 → 记忆不覆盖它', () => {
    const result = applyRecentWorkspace(
      context({ mode: 'lightweight', filePath: 'D:/notes/a.md', documentType: 'markdown' }),
      on,
      alwaysDirectory
    );

    expect(result.filePath).toBe('D:/notes/a.md');
    expect(result.mode).toBe('lightweight');
  });

  it('显式给了一个目录 → 它优先，记忆里那个不算', () => {
    const explicit = context({ mode: 'workspace', workspaceRoot: 'D:/other' });

    expect(applyRecentWorkspace(explicit, on, alwaysDirectory)).toEqual(explicit);
  });

  it('viewer 模式（PDF / 图片）不受影响', () => {
    const viewer = context({ mode: 'viewer', filePath: 'D:/docs/a.pdf', documentType: 'pdf' });

    expect(applyRecentWorkspace(viewer, on, alwaysDirectory)).toEqual(viewer);
  });

  /**
   * **这一条是踩过的坑**：`parseLaunchArgs` 对「不在白名单里的文件」返回的是
   * `lightweight` + `filePath: null` + `unsupportedPath: <那个文件>` —— 与「什么都没给」
   * 只差最后一个字段。只判 mode 与 filePath 的话，打开一个 `.xyz` 会静默变成上次的工作区，
   * 那句「不支持的文件」提示再也不会出现。
   */
  it('**打开一个不支持的文件 → 不接手**，否则那句提示会被吞掉', () => {
    const unsupported = context({
      mode: 'lightweight',
      filePath: null,
      unsupportedPath: 'D:/notes/whatever.xyz'
    });

    expect(applyRecentWorkspace(unsupported, on, alwaysDirectory)).toEqual(unsupported);
  });
});
