// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LAUNCH_CONTEXT, type LaunchContext } from '@nexus/core';
import {
  applyRecentWorkspace,
  EMPTY_RECENT_WORKSPACE,
  listRecentWorkspaces,
  parseRecentWorkspace,
  readRecentWorkspace,
  RECENT_WORKSPACE_LIMIT,
  recentWorkspacePath,
  recordRecentWorkspace,
  writeRecentWorkspace
} from '../electron/recent-workspace.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 「最近打开的工作区」的落盘、启动回落与菜单列表。
 *
 * 为什么这一层能在**不启动 Electron** 的前提下把行为测全：模块收的是**目录**而不是
 * 自己去问 `app.getPath('userData')`，所以一个临时目录就是完整的运行环境。
 * 主进程那边只负责把路径传进来。
 *
 * 这一层的重点是**失败方向**：恢复一个工作区等于对那个目录做一次授权（写权限），
 * 所以下面有一整组「坏值一律不恢复」的用例。
 */

const workspace = 'D:/notes/vault';
const otherWorkspace = 'E:/notes/second';
const alwaysDirectory = (): boolean => true;
const neverDirectory = (): boolean => false;

function context(patch: Partial<LaunchContext> = {}): LaunchContext {
  return { ...DEFAULT_LAUNCH_CONTEXT, ...patch };
}

function state(
  patch: Partial<{ restoreLastWorkspace: boolean; workspaceRoots: string[] }> = {}
): { restoreLastWorkspace: boolean; workspaceRoots: string[] } {
  return { restoreLastWorkspace: true, workspaceRoots: [workspace], ...patch };
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
    writeRecentWorkspace(directory, state());

    expect(readRecentWorkspace(directory)).toEqual(state());
  });

  it('目录还不存在时会建出来 —— 首次运行时 userData 可能刚被清过', () => {
    const nested = path.join(directory, 'a', 'b');

    writeRecentWorkspace(nested, state({ restoreLastWorkspace: false }));

    expect(readRecentWorkspace(nested).workspaceRoots).toEqual([workspace]);
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
   * 这一组盯的是「写坏的存档」这个方向。开关与目录列的判据**不同**：
   * 开关回落到这一项的默认值（开），目录列则一律当作「没记过」—— 后者才是那张写权限。
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
    expect(parseRecentWorkspace({ restoreLastWorkspace: 'yes', workspaceRoot: workspace })).toEqual({
      restoreLastWorkspace: true,
      workspaceRoots: [workspace]
    });
  });

  it('空串的工作区路径按「没记过」处理，不是一个路径', () => {
    // `fs.statSync('')` 在各平台上的行为不一致，不该让它走到判目录那一步。
    expect(parseRecentWorkspace({ restoreLastWorkspace: true, workspaceRoot: '   ' })).toEqual({
      restoreLastWorkspace: true,
      workspaceRoots: []
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

/**
 * 旧文件兼容。**这一组是升级路径的哨兵**：这个文件原本只记一个根，已经装过的机器上
 * 就是那个形状。不认旧字段的话，升级后第一次启动会以为「从没打开过工作区」——
 * 菜单空了、启动回落也没了，而用户什么都没做错。
 */
describe('最近工作区 · 旧文件兼容', () => {
  it('旧形状（单个 workspaceRoot）被读成一列', () => {
    expect(parseRecentWorkspace({ restoreLastWorkspace: true, workspaceRoot: workspace })).toEqual({
      restoreLastWorkspace: true,
      workspaceRoots: [workspace]
    });
  });

  it('旧形状里的 null 读成空列', () => {
    expect(
      parseRecentWorkspace({ restoreLastWorkspace: false, workspaceRoot: null }).workspaceRoots
    ).toEqual([]);
  });

  it('旧形状的开关照样认', () => {
    expect(
      parseRecentWorkspace({ restoreLastWorkspace: false, workspaceRoot: workspace })
        .restoreLastWorkspace
    ).toBe(false);
  });

  it('两个字段都在时新字段赢 —— 旧字段是历史遗留，不该覆盖现在写出去的那个', () => {
    expect(
      parseRecentWorkspace({
        restoreLastWorkspace: true,
        workspaceRoot: 'D:/stale',
        workspaceRoots: [workspace]
      }).workspaceRoots
    ).toEqual([workspace]);
  });

  it('新字段不是数组时回落到旧字段，而不是整份作废', () => {
    expect(
      parseRecentWorkspace({
        restoreLastWorkspace: true,
        workspaceRoot: workspace,
        workspaceRoots: 'D:/oops'
      }).workspaceRoots
    ).toEqual([workspace]);
  });

  it('列里混着坏值时只丢掉坏的那些', () => {
    expect(
      parseRecentWorkspace({ workspaceRoots: [workspace, 42, '', null, otherWorkspace] })
        .workspaceRoots
    ).toEqual([workspace, otherWorkspace]);
  });
});

describe('最近工作区 · 记录（recordRecentWorkspace）', () => {
  it('新目录插到最前 —— 这一列的顺序就是菜单的显示顺序', () => {
    const next = recordRecentWorkspace(state(), otherWorkspace);

    expect(next.workspaceRoots).toEqual([otherWorkspace, workspace]);
  });

  it('已记过的目录被提到最前，而不是重复一条', () => {
    const next = recordRecentWorkspace(state({ workspaceRoots: [workspace, otherWorkspace] }), otherWorkspace);

    expect(next.workspaceRoots).toEqual([otherWorkspace, workspace]);
  });

  it('提上来时保留原有的写法，不换成比较键', () => {
    // 菜单里要显示用户认得出的那条路径，而不是 `d:\notes\vault` 这种折叠过大小写的键。
    const next = recordRecentWorkspace(state({ workspaceRoots: [workspace] }), 'd:/notes/vault');

    expect(next.workspaceRoots).toEqual([workspace]);
  });

  it('归一化后相同的写法算同一个目录 —— 结尾分隔符与 `.` 段不算区分度', () => {
    const next = recordRecentWorkspace(state({ workspaceRoots: [workspace] }), `${workspace}/.`);

    expect(next.workspaceRoots).toEqual([workspace]);
  });

  it('归一之后不同目录仍然是两条 —— 归一只吃掉写法差异', () => {
    const next = recordRecentWorkspace(state({ workspaceRoots: [workspace] }), otherWorkspace);

    expect(next.workspaceRoots).toHaveLength(2);
  });

  it('超出上限时挤掉最旧的那个', () => {
    let current = state({ workspaceRoots: [] });
    for (let index = 0; index < RECENT_WORKSPACE_LIMIT + 3; index += 1) {
      current = recordRecentWorkspace(current, `D:/notes/vault-${index}`);
    }

    expect(current.workspaceRoots).toHaveLength(RECENT_WORKSPACE_LIMIT);
    // 最近的还在最前，最旧的那几个被挤掉了
    expect(current.workspaceRoots[0]).toBe(`D:/notes/vault-${RECENT_WORKSPACE_LIMIT + 2}`);
    expect(current.workspaceRoots).not.toContain('D:/notes/vault-0');
  });

  it('空串 / 纯空白不改动状态 —— 它不是一次「记录」', () => {
    expect(recordRecentWorkspace(state(), '   ')).toEqual(state());
  });

  it('开关状态原样带过去', () => {
    expect(recordRecentWorkspace(state({ restoreLastWorkspace: false }), otherWorkspace)
      .restoreLastWorkspace).toBe(false);
  });

  it('不改动入参 —— 是纯函数', () => {
    const original = state();
    const before = [...original.workspaceRoots];

    recordRecentWorkspace(original, otherWorkspace);

    expect(original.workspaceRoots).toEqual(before);
  });
});

describe('最近工作区 · 菜单列表（listRecentWorkspaces）', () => {
  it('只留下现在还在的目录，顺序不变', () => {
    const current = state({ workspaceRoots: [workspace, otherWorkspace] });

    expect(listRecentWorkspaces(current, (target) => target === otherWorkspace)).toEqual([
      otherWorkspace
    ]);
  });

  it('一个都不在时返回空数组，而不是让调用方去判 null', () => {
    expect(listRecentWorkspaces(state(), neverDirectory)).toEqual([]);
  });

  it('没记过任何目录时是空数组', () => {
    expect(listRecentWorkspaces(state({ workspaceRoots: [] }), alwaysDirectory)).toEqual([]);
  });

  it('**不因为开关关着就不给列表** —— 那一项管的是启动行为，不是菜单', () => {
    expect(
      listRecentWorkspaces(state({ restoreLastWorkspace: false }), alwaysDirectory)
    ).toEqual([workspace]);
  });
});

describe('最近工作区 · 启动回落', () => {
  it('设置开着 + 目录还在 → 进工作区模式', () => {
    const result = applyRecentWorkspace(context(), state(), alwaysDirectory);

    expect(result.mode).toBe('workspace');
    expect(result.workspaceRoot).toBe(workspace);
    expect(result.filePath).toBeNull();
  });

  it('设置关着 → 一动不动（不自动接手，由欢迎态让用户自己选）', () => {
    const result = applyRecentWorkspace(
      context(),
      state({ restoreLastWorkspace: false }),
      alwaysDirectory
    );

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  it('没记过目录 → 一动不动', () => {
    const result = applyRecentWorkspace(context(), state({ workspaceRoots: [] }), alwaysDirectory);

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  it('目录已经不在了（被删 / 被改名）→ 一动不动，而不是进一个空工作区', () => {
    const result = applyRecentWorkspace(context(), state(), neverDirectory);

    expect(result).toEqual(DEFAULT_LAUNCH_CONTEXT);
  });

  /**
   * **这一条是「只认第一个」与「往下找」的分界**。上次的工作区在移动硬盘或网络盘上是常态，
   * 盘没插的时候只认第一个，结果是「每次启动都进欢迎态」—— 用户读到的是「这个功能坏了」，
   * 而不是「那个盘不在」。
   */
  it('第一个目录不在了就往下找第一个还存在的', () => {
    const current = state({ workspaceRoots: [workspace, otherWorkspace] });

    const result = applyRecentWorkspace(context(), current, (target) => target === otherWorkspace);

    expect(result.workspaceRoot).toBe(otherWorkspace);
  });

  it('全都不可用时一动不动', () => {
    const current = state({ workspaceRoots: [workspace, otherWorkspace] });

    expect(applyRecentWorkspace(context(), current, neverDirectory)).toEqual(
      DEFAULT_LAUNCH_CONTEXT
    );
  });

  it('显式给了一个 Markdown 文件 → 记忆不覆盖它', () => {
    const result = applyRecentWorkspace(
      context({ mode: 'lightweight', filePath: 'D:/notes/a.md', documentType: 'markdown' }),
      state(),
      alwaysDirectory
    );

    expect(result.filePath).toBe('D:/notes/a.md');
    expect(result.mode).toBe('lightweight');
  });

  it('显式给了一个目录 → 它优先，记忆里那个不算', () => {
    const explicit = context({ mode: 'workspace', workspaceRoot: 'D:/other' });

    expect(applyRecentWorkspace(explicit, state(), alwaysDirectory)).toEqual(explicit);
  });

  it('viewer 模式（PDF / 图片）不受影响', () => {
    const viewer = context({ mode: 'viewer', filePath: 'D:/docs/a.pdf', documentType: 'pdf' });

    expect(applyRecentWorkspace(viewer, state(), alwaysDirectory)).toEqual(viewer);
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

    expect(applyRecentWorkspace(unsupported, state(), alwaysDirectory)).toEqual(unsupported);
  });
});
