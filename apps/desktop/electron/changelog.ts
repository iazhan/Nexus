/**
 * 更新日志：**双语条目** + 三层回落。
 *
 * ## 数据从哪来（按优先级）
 *
 * 1. **远端 `changelog.json`**（`raw.githubusercontent.com`）—— 最新的双语条目。
 *    发版时人工补，所以它同时覆盖「比本包更新的版本」。
 * 2. **内置 `changelog.json`**（随包，走 `extraResources`）—— 离线兜底，
 *    覆盖到打包那一刻为止的版本。
 * 3. **GitHub Releases 的 notes** —— 最后一层。只有英文（提交信息原样），
 *    而且早期版本可能一条都没有（流水线那时还没生成 notes）。
 *
 * **按版本合并而不是整体二选一**：装 0.73.0 时，0.64.0–0.73.0 可能三层都有，
 * 而 0.74.0 只有远端有。任一层失败都不影响另外两层。
 *
 * ## 为什么读文件 / 发请求都在参数里
 *
 * 与 `recent-workspace.ts` 的「目录由调用方给」同一条纪律：**本模块不 import electron**，
 * 所以 `dir` 与 `fetch` 都是入参 —— `changelog.test.ts` 拿一个临时目录加一个假 `fetch`
 * 就能测全部行为（含三条回落路径与全部失败方向），不必起真窗口、也不必联网。
 *
 * ## 失败方向
 *
 * 三层全空 → 返回 `null`（界面显示「无法获取」），**不返回空数组**。
 * 空数组的意思是「拿到了，但没有比当前版本更新的条目」，两者给用户的下一步动作完全不同：
 * 前者是「去 GitHub 看」，后者是「你已经是最新的」。
 *
 * ## 条目语言怎么判
 *
 * GitHub 那层拿到的是**自由文本**（提交信息），没有语言字段。判据是**有没有 CJK 字符**：
 * 有就归 `zh`，没有就归 `en`。流水线生成的 notes 里标题是中文的、条目是英文的，
 * 而「（本次发布没有新增提交）」这种占位是中文的 —— 按字符判比按位置猜准。
 *
 * ## 什么不算「变更」
 *
 * 测试、CI、构建、代码格式这些提交**不进日志** —— 它们说明的是「这个仓库怎么维护的」，
 * 不是「这个版本变了什么」。双语那份是人工写的，由 `changelog.test.ts` 的守卫用例挡住；
 * GitHub 那层是提交信息原文，只能在这里滤（见 `INTERNAL_TYPES`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions,
  type ChangelogEntry,
  type ChangelogRelease,
  type ChangelogResult
} from '../ipc/channels.js';

export const CHANGELOG_FILE = 'changelog.json';

/**
 * 远端那份。
 *
 * **与 `electron-builder.yml` 的 `publish.repo` 同源**（`iazhan/Nexus`），改一处要改两处。
 * 走 `raw.githubusercontent.com` 而不是 API：那是不带速率限制的静态文件，
 * 而 GitHub API 匿名只有 60 次/小时/IP。
 */
export const CHANGELOG_REMOTE_URL =
  'https://raw.githubusercontent.com/iazhan/Nexus/master/changelog.json';

/** 兜底那层的接口。`per_page=30` 够用 —— 界面最多也就展示这么多版本。 */
export const RELEASES_API_URL = 'https://api.github.com/repos/iazhan/Nexus/releases?per_page=30';

/** 拉取超时。更新窗口是短命窗口，不能等一个挂住的请求。 */
export const FETCH_TIMEOUT_MS = 8_000;

/** CJK 判定。够用即可 —— 它只用来决定一个自由文本条目归到哪个语言字段。 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 列表项：`- xxx` / `* xxx`。**只认这一种行** —— notes 里的元信息行不带前缀，自然被滤掉。 */
const LIST_ITEM = /^\s*[-*]\s+(.*\S)\s*$/;

/** 提交信息的 `type(scope): subject` 前缀。拆不出就整条当文本。 */
const COMMIT_PREFIX = /^([a-z]+)(?:\(([^)]+)\))?:\s*(.+)$/;

/**
 * 更新日志里**不该出现**的提交类型。
 *
 * GitHub 那层的条目就是提交信息原文（流水线用 `git log --pretty='- %s'` 全量列），
 * 而测试、CI、构建、代码格式这些改动对用户没有可感知的影响 —— 它们属于「这个仓库怎么维护的」，
 * 不属于「这个版本变了什么」。把仓库那份双语日志里的 `test` / `chore` 条目清掉只解决一半：
 * 装旧版本的用户、以及任何一层的合并结果里，看到的仍然是 GitHub 那一条。
 *
 * 用**排除表**而不是白名单：没有 `type` 前缀的条目（不遵循提交约定的那些）必须留下 ——
 * 白名单会把它们一起吃掉，而它们可能是那一版唯一一条有用的说明。
 */
export const INTERNAL_TYPES = ['test', 'chore', 'ci', 'build', 'style'] as const;

const INTERNAL_TYPE_SET = new Set<string>(INTERNAL_TYPES);

/** `v0.73.0` / `0.73.0` → `0.73.0`；认不出返回 `null`。 */
export function normalizeVersion(tag: string): string | null {
  const trimmed = tag.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 解析 `changelog.json`。
 *
 * **认不出的键 / 条目一律跳过，不抛** —— 这份文件是人手写的，写错一个版本号不该让整个
 * 更新日志变成「无法获取」。条目里两个语言字段都空的也丢掉（不画一行空的）。
 */
export function parseChangelogFile(raw: unknown, source: 'bundled' | 'remote'): ChangelogRelease[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const releases: ChangelogRelease[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const version = normalizeVersion(key);
    if (!version) continue;

    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const rawChanges = Array.isArray(record.changes) ? record.changes : [];
    const entries: ChangelogEntry[] = [];

    for (const change of rawChanges) {
      if (!change || typeof change !== 'object') continue;
      const item = change as Record<string, unknown>;
      const zh = text(item.zh);
      const en = text(item.en);
      if (!zh && !en) continue;
      entries.push({ type: text(item.type), scope: text(item.scope), zh, en });
    }

    releases.push({ version, date: text(record.date), entries, source });
  }

  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 解析一段 GitHub release body（`- type(scope): subject` 逐行）。
 *
 * `INTERNAL_TYPES` 那些提交被丢掉 —— 理由见那张表。
 */
export function parseGithubBody(body: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];

  for (const line of body.split('\n')) {
    const match = LIST_ITEM.exec(line);
    if (!match) continue;

    const raw = match[1] ?? '';
    const commit = COMMIT_PREFIX.exec(raw);
    const type = commit ? (commit[1] ?? null) : null;
    if (type && INTERNAL_TYPE_SET.has(type)) continue;

    const subject = commit ? (commit[3] ?? raw) : raw;
    const isChinese = CJK.test(subject);

    entries.push({
      type,
      scope: commit ? (commit[2] ?? null) : null,
      zh: isChinese ? subject : null,
      en: isChinese ? null : subject
    });
  }

  return entries;
}

/**
 * 解析 GitHub Releases API 的响应。
 *
 * **过滤 `draft` / `prerelease`** —— 与 OpenKnowledge 的做法一致（`releases.ts` 的同名判据）：
 * 一个还没发布的 draft 不该出现在用户的更新日志里。
 */
export function parseGithubReleases(payload: unknown): ChangelogRelease[] {
  if (!Array.isArray(payload)) return [];

  const releases: ChangelogRelease[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.draft === true || record.prerelease === true) continue;

    const version = normalizeVersion(typeof record.tag_name === 'string' ? record.tag_name : '');
    if (!version) continue;

    const publishedAt = text(record.published_at);
    releases.push({
      version,
      // `2026-10-05T09:48:41Z` → `2026-10-05`。日期只用来显示，不要时区换算。
      date: publishedAt ? publishedAt.slice(0, 10) : null,
      entries: parseGithubBody(typeof record.body === 'string' ? record.body : ''),
      source: 'github'
    });
  }

  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 按版本合并多层来源，**先传的优先**。
 *
 * 低优先层只在两种情况下补进来：这个版本高优先层没有，或者高优先层有但**条目为空**
 * （早期版本的 notes 就是空的 —— 那时显示「未提供更新说明」不如让低层的中文条目顶上来）。
 */
export function mergeChangelogs(...layers: ChangelogRelease[][]): ChangelogRelease[] {
  const byVersion = new Map<string, ChangelogRelease>();

  for (const layer of layers) {
    for (const release of layer) {
      const existing = byVersion.get(release.version);
      if (!existing || (existing.entries.length === 0 && release.entries.length > 0)) {
        byVersion.set(release.version, release);
      }
    }
  }

  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** 读内置文件。缺失 / 坏掉都返回空数组。 */
export function readBundledChangelog(dir: string): ChangelogRelease[] {
  try {
    const raw = fs.readFileSync(path.join(dir, CHANGELOG_FILE), 'utf8');
    return parseChangelogFile(JSON.parse(raw), 'bundled');
  } catch {
    return [];
  }
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export interface LoadChangelogDeps {
  /** 内置文件所在目录。打包后是 `process.resourcesPath`，dev 下是仓库根。 */
  dir: string;
  fetchImpl?: typeof fetch;
}

/**
 * 三层回落取更新日志，按版本降序。
 *
 * 三层是**并发**发的：它们互相独立，串行只会让打开窗口时的等待翻倍。
 */
export async function loadChangelog(deps: LoadChangelogDeps): Promise<ChangelogResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const [remotePayload, githubPayload] = await Promise.all([
    fetchJson(CHANGELOG_REMOTE_URL, { accept: 'application/json' }, fetchImpl),
    fetchJson(
      RELEASES_API_URL,
      {
        accept: 'application/vnd.github+json',
        // GitHub 对**没有 UA 的请求直接 403** —— 这个头不是礼貌，是必需。
        'user-agent': 'Nexus-Desktop'
      },
      fetchImpl
    )
  ]);

  const merged = mergeChangelogs(
    parseChangelogFile(remotePayload, 'remote'),
    readBundledChangelog(deps.dir),
    parseGithubReleases(githubPayload)
  );

  return merged.length > 0 ? merged : null;
}
