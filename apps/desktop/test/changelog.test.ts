// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_FILE,
  CHANGELOG_REMOTE_URL,
  INTERNAL_TYPES,
  parseGithubTags,
  RELEASES_API_URL,
  loadChangelog,
  mergeChangelogs,
  normalizeVersion,
  parseChangelogFile,
  parseGithubBody,
  parseGithubReleases,
  readBundledChangelog,
  TAGS_API_URL
} from '../electron/changelog.js';
import { compareVersions, type ChangelogRelease } from '../ipc/channels.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 更新日志：双语条目 + 三层回落（远端 JSON → 内置 JSON → GitHub Releases），
 * 外加一路只产事实的 tag 列表。
 *
 * 这一层全部是纯函数与「收目录 / 收 fetch」的加载器，所以能在**不启动 Electron、不联网**
 * 的前提下测完三条回落路径与所有失败方向 —— 与 `recent-workspace.ts` 同一条纪律。
 *
 * 重点在三处：
 *
 * 1. **失败方向**。`loadChangelog` 三层全空 + tag 一个都没读到时返回 `null`（「拿不到」），
 *    而不是空载荷（「拿到了，只是没有更新的条目」）—— 这两种情况给用户看的文案与下一步动作
 *    完全不同。
 * 2. **合并规则**。低优先层只在「该版本高优先层没有」或「有但条目为空」时补进来。
 *    第二条是给早期版本留的：那时流水线还没生成 notes，显示「未提供更新说明」
 *    不如让下一层的中文条目顶上来。
 * 3. **tag 列表是独立的一路**。它不写进日志，只在「哪些版本真的发布过」这件事上说话 ——
 *    CI 编译中（release 未发布）能看到最新版内容，靠的就是它。
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

/** tags API 的一条 ref。 */
function tagRef(version: string) {
  return { ref: `refs/tags/${version}`, object: { sha: '0'.repeat(40) } };
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

describe('更新日志 · 解析 GitHub tags 响应', () => {
  it('不是数组就返回空数组', () => {
    for (const payload of [null, 42, {}, 'x']) {
      expect(parseGithubTags(payload)).toEqual([]);
    }
  });

  it('ref 归一成不带 v 的版本号', () => {
    expect(parseGithubTags([tagRef('v0.85.0'), tagRef('0.84.8')])).toEqual(['0.85.0', '0.84.8']);
  });

  /** 只有名字有用：sha 在这里没有意义（判的是「发布过没有」，不是「指向哪个提交」）。 */
  it('item 没有 ref / ref 不在 refs/tags 底下就跳过', () => {
    expect(parseGithubTags([{ sha: 'x' }, { ref: 'refs/heads/master' }, 42, null])).toEqual([]);
  });

  it('认不出的 tag 名跳过 —— nightly 这种不是版本号', () => {
    expect(parseGithubTags([tagRef('v0.85.0'), tagRef('nightly'), tagRef('latest')])).toEqual([
      '0.85.0'
    ]);
  });

  it('重复的版本去重', () => {
    expect(parseGithubTags([tagRef('v0.85.0'), tagRef('0.85.0')])).toEqual(['0.85.0']);
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
      [RELEASES_API_URL]: [githubRelease('v0.70.0', '- feat: github entry')],
      [TAGS_API_URL]: [tagRef('v0.74.0'), tagRef('v0.72.0'), tagRef('v0.70.0')]
    });

    const result = await loadChangelog({ dir: directory, fetchImpl });

    expect(result?.releases.map((release) => [release.version, release.source])).toEqual([
      ['0.74.0', 'remote'],
      ['0.72.0', 'bundled'],
      ['0.70.0', 'github']
    ]);
    // tag 那一路只产事实，不混进日志
    expect(result?.tagged).toEqual(['0.74.0', '0.72.0', '0.70.0']);
  });

  it('远端挂了不影响另外两层', async () => {
    writeBundled(remoteFile('0.72.0', '内置那条'));
    const fetchImpl = fakeFetch({
      [CHANGELOG_REMOTE_URL]: 'THROW',
      [RELEASES_API_URL]: [githubRelease('v0.70.0', '- feat: github entry')],
      [TAGS_API_URL]: [tagRef('v0.70.0')]
    });

    const result = await loadChangelog({ dir: directory, fetchImpl });
    expect(result?.releases.map((release) => release.version)).toEqual(['0.72.0', '0.70.0']);
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
      [RELEASES_API_URL]: [githubRelease('v0.68.0', '')],
      [TAGS_API_URL]: [tagRef('v0.68.0')]
    });

    const [release] = (await loadChangelog({ dir: directory, fetchImpl }))?.releases ?? [];
    expect(release).toMatchObject({ version: '0.68.0', source: 'bundled' });
    expect(release?.entries).toHaveLength(1);
  });

  it('GitHub 那两次请求带 User-Agent —— 不带会被直接 403，这不是礼貌是必需', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = fakeFetch(
      {
        [CHANGELOG_REMOTE_URL]: remoteFile('0.74.0', '远端'),
        [RELEASES_API_URL]: [],
        [TAGS_API_URL]: [tagRef('v0.74.0')]
      },
      calls
    );

    await loadChangelog({ dir: directory, fetchImpl });

    for (const url of [RELEASES_API_URL, TAGS_API_URL]) {
      const call = calls.find((item) => item.url === url);
      expect(call?.headers['user-agent'], `${url} 少带了 UA`).toBeTruthy();
    }
  });

  /**
   * **tag 打了、release 还没发布**（CI 还在编译）—— 这正是用户要在应用里看到
   * 「最新版更新内容」的那段时间。tag 已经在仓库里，releases API 还答不上来，
   * 而日志那一层照样有 0.86.0 的键（双语条目在打 tag 前就搬进了 `changelog.json`）。
   */
  it('CI 编译中：tag 有了、release 还没发，那一版照样拿得到', async () => {
    writeBundled(remoteFile('0.86.0', '即将发布那一条'));
    const fetchImpl = fakeFetch({
      // 远端那份还没有 0.86.0（tag 刚打，master 上的 changelog.json 可能还没同步过来）
      [CHANGELOG_REMOTE_URL]: remoteFile('0.85.0', '已发布那一条'),
      // releases API 只列到 0.85.0 —— 0.86.0 的 release 还没建
      [RELEASES_API_URL]: [githubRelease('v0.85.0', '- feat: shipped')],
      // 但 tag 有了
      [TAGS_API_URL]: [tagRef('v0.86.0'), tagRef('v0.85.0')]
    });

    const result = await loadChangelog({ dir: directory, fetchImpl });

    expect(result?.releases.map((release) => release.version)).toEqual(['0.86.0', '0.85.0']);
    expect(result?.tagged).toContain('0.86.0');
  });

  /** tag 那一路挂了不影响日志 —— 上界回落到 `latest`，由 `UpdateView` 负责。 */
  it('tag 列表拿不到时 tagged 是空数组，日志照常', async () => {
    writeBundled(remoteFile('0.72.0', '内置那条'));
    const fetchImpl = fakeFetch({
      [CHANGELOG_REMOTE_URL]: remoteFile('0.74.0', '远端那条'),
      [RELEASES_API_URL]: [githubRelease('v0.70.0', '- feat: github entry')],
      [TAGS_API_URL]: 'THROW'
    });

    const result = await loadChangelog({ dir: directory, fetchImpl });
    expect(result?.tagged).toEqual([]);
    expect(result?.releases.map((release) => release.version)).toEqual(['0.74.0', '0.72.0', '0.70.0']);
  });

  it('三路请求是并发发的 —— 串行会让打开窗口时的等待翻倍', async () => {
    let started = 0;
    let releaseAll: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

  // 三个网络请求（远端 JSON / releases API / tags API）+ 一次同步读文件。
  // 这一次不看 URL，只看「三个请求是不是同时在飞」—— 所以参数不用。
  const fetchImpl = (async () => {
    started += 1;
    if (started === 3) releaseAll();
    await allStarted;
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  // 若实现是串行的，第一个请求会等一个永远不来的 `allStarted`，这里就会超时。
  await expect(loadChangelog({ dir: directory, fetchImpl })).resolves.toBeNull();
  expect(started).toBe(3);
});
});

describe('更新日志 · 仓库里那份文件', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  /**
   * 仓库里打过 tag 的版本（去掉前导 `v`）。
   *
   * **直接读 `.git` 里的 ref，不起子进程。** 用 `git tag` 看着更自然，但本机沙箱里
   * `execFileSync('git', …)` 会以 `EBUSY spawnSync git EBUSY` 失败 —— 失败被 `catch` 掉之后
   * 守卫就成了一条**恒真**的断言：测试全绿，什么都没查。第一版就是这么写坏的（反向验证时
   * 塞进一个未发布的键，测试照样绿）。读文件没有这层不确定性。
   *
   * tag 有两处存放，**两处都要读**：松散引用 `.git/refs/tags/<name>`，和打包后的
   * `.git/packed-refs`（本仓库 36 个 tag：5 个松散、31 个在 packed-refs 里 —— 只读一处会漏）。
   *
   * **读不到就返回空数组**（导出源码包、没有 `.git`）：那时「有没有发布过」无从判断，
   * 调用方见空数组就跳过 —— 与 `.githooks` 里那条「找不到 node 就跳过校验并放行」同一条纪律。
   */
  function releasedTags(): string[] {
    const gitDir = resolveGitDir(repoRoot);
    if (!gitDir) return [];

    const names = new Set<string>();

    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        // `<sha> refs/tags/<name>`。`^<sha>` 行（附注 tag 指向的提交）与 `#` 注释天然不匹配。
        const match = /^[0-9a-f]{40} refs\/tags\/(.+)$/.exec(line.trim());
        if (match) names.add(match[1] ?? '');
      }
    }

    const looseDir = path.join(gitDir, 'refs', 'tags');
    if (fs.existsSync(looseDir)) {
      for (const name of fs.readdirSync(looseDir)) names.add(name);
    }

    return [...names]
      .map((name) => normalizeVersion(name))
      .filter((version): version is string => version !== null);
  }

  /**
   * `.git` 可能是目录，也可能是一个写着 `gitdir: <path>` 的文件（`git worktree`）。
   * worktree 的 gitdir 只放这个 worktree 私有的东西，而 tag 是**公共引用** ——
   * 要顺着 `commondir` 找到主仓库的 `.git`，否则这里读到零个 tag，守卫又静默跳过。
   */
  function resolveGitDir(root: string): string | null {
    try {
      const dotGit = path.join(root, '.git');
      let gitDir = fs.statSync(dotGit).isDirectory()
        ? dotGit
        : path.resolve(
            root,
            /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim() ?? ''
          );
      if (!fs.existsSync(gitDir)) return null;

      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) {
        const raw = fs.readFileSync(common, 'utf8').trim();
        if (raw) {
          const shared = path.resolve(gitDir, raw);
          if (fs.existsSync(shared)) gitDir = shared;
        }
      }

      return gitDir;
    } catch {
      return null;
    }
  }

  function currentVersion(): string {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return String(raw.version);
  }

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

  /**
   * **`changelog.json` 的键 = 发布过的版本。** 两个方向都守。
   *
   * 这条不变量整个更新窗口都建在它上面 —— `docs/update-about-redesign-plan.md` 里那段
   * 「区间是 tag 到 tag，**未打 tag 的版本并入了下一次发布**」是设计前提，不是巧合。
   * 而它此前没有任何东西在守，于是 2026-10-14 漂了：从 0.83.0 起，每个开发提交都顺手把
   * 自己的版本号写进 changelog.json，用户从 0.80.0 更新到 0.84.8 时看到的是**十张卡片**
   * （0.83.0 / 0.84.0 / … / 0.84.8），其中九张对应的版本他根本装不到。
   *
   * 判据是 `git tag`：本仓库「一次提交 = 一次版本推进」，版本号跑在 tag 前面，
   * tag 是「这个版本真的发布过」的唯一落款。
   *
   * **这一条取代了原来那份手写哨兵列表**（`['0.64.0', …, '0.84.8']`）—— 那份清单自己也漂了
   * （它当时列着 0.83.0 与 0.84.0，两个都没打过 tag）。凡「手工维护一份清单来守不变量」，
   * 清单本身就会跟着漂；能推出来的就别手写。
   */
  it('changelog.json 的键 = 发布过的版本，两个方向都守', () => {
    const tags = releasedTags();
    if (tags.length === 0) return;

    const released = new Set(tags);
    const current = currentVersion();
    const keys = readBundledChangelog(repoRoot).map((release) => release.version);

    // 方向一：不许有没发布过的键。
    // **当前版本是唯一的例外** —— 发版顺序是「推进版本 → 写双语条目 → 提交 → 打 tag」，
    // 写条目那一刻 tag 还不存在，而那个键正是马上就要打上去的那一个。
    const unreleased = keys.filter((version) => version !== current && !released.has(version));
    expect(
      unreleased,
      `这些键没有对应的 tag，说明它们还没发布过。双语条目应该先攒在 ` +
        `.workbuddy-ai/memory/pending-changelog.md 里，打 tag 时再整段搬进 changelog.json：` +
        unreleased.join(', ')
    ).toEqual([]);

    // 方向二：不许漏。从**最老的键**起，每一个发布过的版本都得有键 ——
    // 「覆盖区间」由文件自己定义，所以这里不需要写死一个起始版本号。
    // 漏了的话更新窗口会回落到 GitHub 那层（英文、提交信息原文），用户看到一串英文。
    const oldest = keys.reduce(
      (min, version) => (compareVersions(version, min) < 0 ? version : min),
      keys[0] ?? current
    );
    const missing = tags.filter(
      (version) => compareVersions(version, oldest) >= 0 && !keys.includes(version)
    );
    expect(
      missing,
      `这些版本打过 tag 却没有双语条目。发版时手写，这里守住别漏：` + missing.join(', ')
    ).toEqual([]);
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
