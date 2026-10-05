// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_FILE,
  CHANGELOG_REMOTE_URL,
  INTERNAL_TYPES,
  RELEASES_API_URL,
  loadChangelog,
  mergeChangelogs,
  normalizeVersion,
  parseChangelogFile,
  parseGithubBody,
  parseGithubReleases,
  readBundledChangelog
} from '../electron/changelog.js';
import type { ChangelogRelease } from '../ipc/channels.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 更新日志：双语条目 + 三层回落（远端 JSON → 内置 JSON → GitHub Releases）。
 *
 * 这一层全部是纯函数与「收目录 / 收 fetch」的加载器，所以能在**不启动 Electron、不联网**
 * 的前提下测完三条回落路径与所有失败方向 —— 与 `recent-workspace.ts` 同一条纪律。
 *
 * 重点在两处：
 *
 * 1. **失败方向**。`loadChangelog` 三层全空返回 `null`（「拿不到」），而不是空数组
 *    （「拿到了，只是没有更新的条目」）—— 这两种情况给用户看的文案与下一步动作完全不同。
 * 2. **合并规则**。低优先层只在「该版本高优先层没有」或「有但条目为空」时补进来。
 *    第二条是给早期版本留的：那时流水线还没生成 notes，显示「未提供更新说明」
 *    不如让下一层的中文条目顶上来。
 */

/** 假 `fetch`：按 URL 查表返回，并把每次调用的头记下来供断言。 */
function fakeFetch(
  routes: Record<string, unknown>,
  calls: { url: string; headers: Record<string, string> }[] = []
): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });

    if (!(url in routes)) return new Response('', { status: 404 });
    const payload = routes[url];
    if (payload === 'THROW') throw new Error('network down');
    if (typeof payload === 'number') return new Response('', { status: payload });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
}

/** 只带一条中文条目的远端 JSON。 */
function remoteFile(version: string, zh: string) {
  return { [version]: { date: '2026-10-01', changes: [{ type: 'feat', zh }] } };
}

/** 只带一条英文条目的 GitHub release。 */
function githubRelease(tag: string, body: string) {
  return {
    tag_name: tag,
    body,
    draft: false,
    prerelease: false,
    published_at: '2026-10-02T09:48:41Z'
  };
}

describe('更新日志 · 版本号归一', () => {
  it('去掉前导 v，大小写都认', () => {
    expect(normalizeVersion('v0.73.0')).toBe('0.73.0');
    expect(normalizeVersion('V1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('  0.73.0  ')).toBe('0.73.0');
  });

  it('保留 prerelease 尾巴', () => {
    expect(normalizeVersion('v0.74.0-beta.1')).toBe('0.74.0-beta.1');
  });

  it('认不出的返回 null，而不是抛 —— 输入来自网络与人手写的 JSON', () => {
    for (const tag of ['', 'latest', 'v', '1.2', 'x.y.z', '1.2.3.4.5']) {
      expect(normalizeVersion(tag)).toBeNull();
    }
  });
});

describe('更新日志 · 解析 changelog.json', () => {
  it('不是对象就返回空数组', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expect(parseChangelogFile(raw, 'bundled')).toEqual([]);
    }
  });

  it('键被归一成不带 v 的版本号，并按版本降序', () => {
    const releases = parseChangelogFile(
      { 'v0.70.0': { changes: [{ zh: '甲' }] }, '0.73.0': { changes: [{ zh: '乙' }] } },
      'remote'
    );
    expect(releases.map((release) => release.version)).toEqual(['0.73.0', '0.70.0']);
  });

  it('认不出的键跳过，不影响同文件里其它版本 —— 写错一个版本号不该让整份日志消失', () => {
    const releases = parseChangelogFile(
      { latest: { changes: [{ zh: '不要' }] }, '0.73.0': { changes: [{ zh: '要' }] } },
      'bundled'
    );
    expect(releases.map((release) => release.version)).toEqual(['0.73.0']);
  });

  it('两个语言字段都空的条目被丢掉，不画一行空的', () => {
    const [release] = parseChangelogFile(
      { '0.73.0': { changes: [{ zh: '有' }, { zh: '  ' }, {}, { type: 'fix' }, null] } },
      'bundled'
    );
    expect(release?.entries).toHaveLength(1);
    expect(release?.entries[0]?.zh).toBe('有');
  });

  it('type / scope / date 缺了就是 null，不是 undefined', () => {
    const [release] = parseChangelogFile({ '0.73.0': { changes: [{ en: 'x' }] } }, 'bundled');
    expect(release?.date).toBeNull();
    expect(release?.entries[0]).toEqual({ type: null, scope: null, zh: null, en: 'x' });
  });

  it('有 date / type / scope 时原样带上', () => {
    const [release] = parseChangelogFile(
      {
        '0.73.0': {
          date: '2026-10-01',
          changes: [{ type: 'feat', scope: 'desktop', zh: '加了个东西' }]
        }
      },
      'remote'
    );
    expect(release).toMatchObject({ version: '0.73.0', date: '2026-10-01', source: 'remote' });
    expect(release?.entries[0]).toMatchObject({ type: 'feat', scope: 'desktop' });
  });

  it('source 如实标出来源', () => {
    expect(parseChangelogFile({ '0.73.0': { changes: [{ zh: 'x' }] } }, 'bundled')[0]?.source).toBe(
      'bundled'
    );
  });

  it('changes 不是数组时该版本照样列出来，只是没有条目', () => {
    const [release] = parseChangelogFile({ '0.73.0': { changes: 'nope' } }, 'bundled');
    expect(release?.entries).toEqual([]);
  });
});

describe('更新日志 · 解析 GitHub release body', () => {
  it('只认 - / * 开头的行，元信息行自然被滤掉', () => {
    const entries = parseGithubBody(
      ['### 变更', '', '- feat: add a thing', '**完整变更**: v0.72.0...v0.73.0', '* fix: another'].join(
        '\n'
      )
    );
    expect(entries).toHaveLength(2);
  });

  it('拆出 type 与 scope，拆不出就整条当文本', () => {
    const entries = parseGithubBody(['- feat(desktop): 加了更新窗口', '- 一句没有前缀的话'].join('\n'));
    expect(entries[0]).toMatchObject({ type: 'feat', scope: 'desktop', zh: '加了更新窗口' });
    expect(entries[1]).toMatchObject({ type: null, scope: null });
  });

  it('按有没有 CJK 字符分语言 —— 提交信息是自由文本，没有语言字段', () => {
    const entries = parseGithubBody(['- feat: 中文条目', '- fix: english entry'].join('\n'));
    expect(entries[0]).toMatchObject({ zh: '中文条目', en: null });
    expect(entries[1]).toMatchObject({ zh: null, en: 'english entry' });
  });

  it('中英混排的条目归中文 —— 有 CJK 就算', () => {
    const entries = parseGithubBody('- feat: add 更新窗口');
    expect(entries[0]?.zh).toBe('add 更新窗口');
    expect(entries[0]?.en).toBeNull();
  });

  it('空 body 得到空数组', () => {
    expect(parseGithubBody('')).toEqual([]);
  });

  /**
   * 流水线用 `git log --pretty='- %s'` **全量**列提交，所以 GitHub 那层天然带着测试、CI、
   * 构建这些条目。它们说的是「仓库怎么维护的」，不是「这个版本变了什么」——
   * 而这一层是装旧版本的用户唯一看得到的那份日志。
   */
  it('测试 / CI / 构建 / 代码格式这些提交不进日志', () => {
    const entries = parseGithubBody(
      [
        '- feat: 用户看得见的东西',
        '- test(desktop): 把应用级测试并进渲染进程项目',
        '- chore(repo): 发布说明改由提交历史生成',
        '- ci: 加一条流水线',
        '- build: 换打包器',
        '- style: 跑一遍格式化',
        '- fix: 另一个用户看得见的东西'
      ].join('\n')
    );

    expect(entries.map((entry) => entry.type)).toEqual(['feat', 'fix']);
  });

  /** 排除表不是白名单：不遵循提交约定的条目必须留下，它可能是那一版唯一一句说明。 */
  it('没有 type 前缀的条目照留', () => {
    expect(parseGithubBody('- 一句没遵循提交约定的话')).toHaveLength(1);
  });
});

describe('更新日志 · 解析 GitHub Releases 响应', () => {
  it('不是数组就返回空数组', () => {
    for (const payload of [null, 42, {}, 'x']) {
      expect(parseGithubReleases(payload)).toEqual([]);
    }
  });

  it('draft 与 prerelease 都被滤掉', () => {
    const releases = parseGithubReleases([
      githubRelease('v0.73.0', '- feat: ok'),
      { ...githubRelease('v0.74.0', '- feat: draft'), draft: true },
      { ...githubRelease('v0.75.0', '- feat: pre'), prerelease: true }
    ]);
    expect(releases.map((release) => release.version)).toEqual(['0.73.0']);
  });

  it('tag 归一、日期截到天、来源标 github', () => {
    const [release] = parseGithubReleases([githubRelease('v0.73.0', '- feat: ok')]);
    expect(release).toMatchObject({ version: '0.73.0', date: '2026-10-02', source: 'github' });
  });

  it('body 为 null 时该版本照样列出来，只是没有条目', () => {
    const releases = parseGithubReleases([
      { tag_name: 'v0.68.0', body: null, published_at: null }
    ]);
    expect(releases[0]).toMatchObject({ version: '0.68.0', date: null, entries: [] });
  });

  it('tag 认不出的条目跳过', () => {
    expect(parseGithubReleases([{ tag_name: 'nightly', body: '- x' }])).toEqual([]);
  });
});

describe('更新日志 · 按版本合并', () => {
  const release = (
    version: string,
    entries: number,
    source: ChangelogRelease['source']
  ): ChangelogRelease => ({
    version,
    date: null,
    source,
    entries: Array.from({ length: entries }, () => ({ type: null, scope: null, zh: 'x', en: null }))
  });

  it('先传的层优先', () => {
    const merged = mergeChangelogs([release('0.73.0', 1, 'remote')], [release('0.73.0', 1, 'bundled')]);
    expect(merged[0]?.source).toBe('remote');
  });

  it('高优先层没有的版本，由低优先层补进来', () => {
    const merged = mergeChangelogs([release('0.74.0', 1, 'remote')], [release('0.73.0', 1, 'bundled')]);
    expect(merged.map((item) => item.version)).toEqual(['0.74.0', '0.73.0']);
  });

  it('高优先层有但条目为空时，低优先层顶上来 —— 早期版本没 notes 就是这一支', () => {
    const merged = mergeChangelogs([release('0.68.0', 0, 'github')], [release('0.68.0', 2, 'bundled')]);
    expect(merged[0]?.source).toBe('bundled');
    expect(merged[0]?.entries).toHaveLength(2);
  });

  it('两层都空时保留高优先层 —— 有版本无条目比没有这个版本更准确', () => {
    const merged = mergeChangelogs([release('0.68.0', 0, 'github')], [release('0.68.0', 0, 'bundled')]);
    expect(merged[0]?.source).toBe('github');
  });

  it('结果按版本降序，与传入顺序无关', () => {
    const merged = mergeChangelogs(
      [release('0.70.0', 1, 'remote')],
      [release('0.73.0', 1, 'bundled')],
      [release('0.68.0', 1, 'github')]
    );
    expect(merged.map((item) => item.version)).toEqual(['0.73.0', '0.70.0', '0.68.0']);
  });

  it('一层都没有时得到空数组', () => {
    expect(mergeChangelogs([], [], [])).toEqual([]);
  });
});

describe('更新日志 · 读内置文件', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-changelog-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('文件不存在返回空数组 —— 不是错误，还有另外两层', () => {
    expect(readBundledChangelog(directory)).toEqual([]);
  });

  it('JSON 坏掉也返回空数组，不抛 —— 调用方在开窗口的路径上', () => {
    fs.writeFileSync(path.join(directory, CHANGELOG_FILE), '{ not json', 'utf8');
    expect(readBundledChangelog(directory)).toEqual([]);
  });

  it('正常文件读出来带 bundled 来源', () => {
    fs.writeFileSync(
      path.join(directory, CHANGELOG_FILE),
      JSON.stringify({ '0.73.0': { changes: [{ zh: '条目' }] } }),
      'utf8'
    );
    expect(readBundledChangelog(directory)[0]).toMatchObject({ version: '0.73.0', source: 'bundled' });
  });
});

describe('更新日志 · 三层回落', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-changelog-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function writeBundled(content: unknown): void {
    fs.writeFileSync(path.join(directory, CHANGELOG_FILE), JSON.stringify(content), 'utf8');
  }

  it('三层各给一个版本时全部拿到，且标对来源', async () => {
    writeBundled(remoteFile('0.72.0', '内置那条'));
    const fetchImpl = fakeFetch({
      [CHANGELOG_REMOTE_URL]: remoteFile('0.74.0', '远端那条'),
      [RELEASES_API_URL]: [githubRelease('v0.70.0', '- feat: github entry')]
    });

    const releases = await loadChangelog({ dir: directory, fetchImpl });

    expect(releases?.map((release) => [release.version, release.source])).toEqual([
      ['0.74.0', 'remote'],
      ['0.72.0', 'bundled'],
      ['0.70.0', 'github']
    ]);
  });

  it('远端挂了不影响另外两层', async () => {
    writeBundled(remoteFile('0.72.0', '内置那条'));
    const fetchImpl = fakeFetch({
      [CHANGELOG_REMOTE_URL]: 'THROW',
      [RELEASES_API_URL]: [githubRelease('v0.70.0', '- feat: github entry')]
    });

    const releases = await loadChangelog({ dir: directory, fetchImpl });
    expect(releases?.map((release) => release.version)).toEqual(['0.72.0', '0.70.0']);
  });

  it('非 2xx 当成没拿到，而不是把响应体当数据解析', async () => {
    const fetchImpl = fakeFetch({ [CHANGELOG_REMOTE_URL]: 500, [RELEASES_API_URL]: 403 });
    expect(await loadChangelog({ dir: directory, fetchImpl })).toBeNull();
  });

  it('三层全空返回 null —— 与「拿到了但没有条目」是两件事', async () => {
    const fetchImpl = fakeFetch({ [CHANGELOG_REMOTE_URL]: {}, [RELEASES_API_URL]: [] });
    expect(await loadChangelog({ dir: directory, fetchImpl })).toBeNull();
  });

  it('网络整体不可用时也返回 null，不抛', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await loadChangelog({ dir: directory, fetchImpl })).toBeNull();
  });

  it('远端该版本条目为空时，内置那层顶上来', async () => {
    writeBundled(remoteFile('0.68.0', '内置补的中文'));
    const fetchImpl = fakeFetch({
      [CHANGELOG_REMOTE_URL]: { '0.68.0': { changes: [] } },
      [RELEASES_API_URL]: [githubRelease('v0.68.0', '')]
    });

    const [release] = (await loadChangelog({ dir: directory, fetchImpl })) ?? [];
    expect(release).toMatchObject({ version: '0.68.0', source: 'bundled' });
    expect(release?.entries).toHaveLength(1);
  });

  it('GitHub 那次请求带 User-Agent —— 不带会被直接 403，这不是礼貌是必需', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = fakeFetch(
      { [CHANGELOG_REMOTE_URL]: remoteFile('0.74.0', '远端'), [RELEASES_API_URL]: [] },
      calls
    );

    await loadChangelog({ dir: directory, fetchImpl });

    const github = calls.find((call) => call.url === RELEASES_API_URL);
    expect(github?.headers['user-agent']).toBeTruthy();
  });

  it('两层是并发发的 —— 串行会让打开窗口时的等待翻倍', async () => {
    let started = 0;
    let releaseBoth: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    // 这一次不看 URL，只看「两个请求是不是同时在飞」—— 所以参数不用。
    const fetchImpl = (async (_input: string) => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    // 若实现是串行的，第一次请求会等一个永远不来的 `bothStarted`，这里就会超时。
    await expect(loadChangelog({ dir: directory, fetchImpl })).resolves.toBeNull();
    expect(started).toBe(2);
  });
});

describe('更新日志 · 仓库里那份文件', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  it('changelog.json 能解析，且每个条目至少有一种语言', () => {
    const releases = readBundledChangelog(repoRoot);

    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      // 键归一之后不该再有前导 v —— 有就说明有人写成了 `v0.74.0` 这种键。
      expect(release.version).not.toMatch(/^v/i);
      for (const entry of release.entries) {
        expect(entry.zh ?? entry.en).toBeTruthy();
      }
    }
  });

  it('已发布过的版本都补了日志 —— 发版时手写，这里守住别漏', () => {
    const versions = new Set(readBundledChangelog(repoRoot).map((release) => release.version));
    for (const version of ['0.64.0', '0.68.0', '0.70.0', '0.73.0', '0.74.0']) {
      expect(versions.has(version)).toBe(true);
    }
  });

  /**
   * 更新日志是给用户看的，所以**测试、CI、构建、代码格式这些改动一条都不该在里面** ——
   * 它们说明的是「这个仓库怎么维护的」，不是「这个版本变了什么」。
   *
   * 这一层挡的是**人工写的那份**：发版时顺手把「跑了一轮测试」「改了流水线」抄进来太容易，
   * 而它在界面上就是一条用户读不懂的噪音。GitHub 那层由 `parseGithubBody` 的排除表挡，
   * 两处共用同一张表（`INTERNAL_TYPES`）。
   */
  it('不含测试 / CI / 构建 / 代码格式这类条目', () => {
    for (const release of readBundledChangelog(repoRoot)) {
      for (const entry of release.entries) {
        expect(
          INTERNAL_TYPES.includes((entry.type ?? '') as (typeof INTERNAL_TYPES)[number]),
          `${release.version}: ${entry.zh ?? entry.en}`
        ).toBe(false);
      }
    }
  });
});
