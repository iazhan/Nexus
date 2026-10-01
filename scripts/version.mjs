#!/usr/bin/env node
/**
 * Nexus 版本号工具 —— 全仓 package.json 的版本单一事实源。
 *
 * 用法：
 *   node scripts/version.mjs show              打印当前版本与各清单一致性
 *   node scripts/version.mjs check             校验一致性；已打 tag 时提示需要 bump
 *   node scripts/version.mjs check --staged    校验暂存区：源码变更是否伴随版本变更
 *                                              （只动注释的源码文件不算行为变更）
 *   node scripts/version.mjs bump <kind>       推进版本：patch | minor | major
 *   node scripts/version.mjs set <x.y.z>       直接设定版本（用于首次对齐）
 *
 * 为什么是「全仓统一版本」而不是每包独立：
 *   10 个包全部 private:true、彼此以 workspace:* 互链、不单独发布到 npm。
 *   独立版本号只会制造 10 个互相漂移的机会，换不来任何收益。
 *
 * 实现约定：只替换顶层 version 字段那一行，不整体重写 JSON。
 *   整体重写会重排字段、丢格式、丢行尾风格；这个仓库的 package.json 是 LF + 2 空格。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 顶层 version 字段（行首、允许前导空白、保留行尾不吞 \r）。 */
const VERSION_FIELD = /^([ \t]*"version"[ \t]*:[ \t]*")([^"\r\n]*)(")/m;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * 收集需要统一版本的清单：仓库根 + apps/* + packages/*。
 * 动态扫描而不是写死列表 —— 新增包时不需要回来改这个脚本。
 */
async function discoverManifests() {
  const rel = ['package.json'];

  for (const group of ['apps', 'packages']) {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, group), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      rel.push(`${group}/${entry.name}/package.json`);
    }
  }

  return rel.sort();
}

async function readManifest(rel) {
  const abs = path.join(ROOT, rel);
  const text = await readFile(abs, 'utf8');
  const match = VERSION_FIELD.exec(text);

  if (!match) {
    throw new Error(`${rel}: 找不到顶层 version 字段`);
  }
  if (!SEMVER.test(match[2])) {
    throw new Error(`${rel}: version 不是 x.y.z 格式 —— "${match[2]}"`);
  }

  return { rel, abs, text, version: match[2] };
}

async function readAll() {
  const manifests = await Promise.all((await discoverManifests()).map(readManifest));
  const versions = new Set(manifests.map((m) => m.version));
  return { manifests, versions };
}

/** 只替换 version 那一行，其余字节原样保留。返回是否真的发生了改动。 */
async function writeVersion(manifest, next) {
  if (manifest.version === next) return false;

  const updated = manifest.text.replace(VERSION_FIELD, `$1${next}$3`);
  if (updated === manifest.text) {
    throw new Error(`${manifest.rel}: 替换 version 字段失败（正则未命中）`);
  }
  await writeFile(manifest.abs, updated, 'utf8');
  return true;
}

function bumpVersion(current, kind) {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`版本号格式非法: ${current}`);

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  switch (kind) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'patch':
      patch += 1;
      break;
    default:
      throw new Error(`未知的版本类型 "${kind}"，只支持 patch | minor | major`);
  }

  return `${major}.${minor}.${patch}`;
}

/** 该版本是否已经打过 tag（打过 = 已发布，再改就必须先 bump）。 */
async function tagExists(version) {
  try {
    const { stdout } = await execFileAsync('git', ['tag', '-l', `v${version}`], { cwd: ROOT });
    return stdout.trim().length > 0;
  } catch {
    // 不是 git 仓库或 git 不可用：不阻塞校验
    return null;
  }
}

function reportInconsistency(manifests) {
  console.error('版本号不一致：\n');
  for (const m of manifests) {
    console.error(`  ${m.version.padEnd(10)} ${m.rel}`);
  }
  console.error('\n修复：node scripts/version.mjs set <x.y.z>');
}

async function cmdShow() {
  const { manifests, versions } = await readAll();
  const consistent = versions.size === 1;

  for (const m of manifests) {
    console.log(`${m.version.padEnd(10)} ${m.rel}`);
  }
  console.log();

  if (!consistent) {
    reportInconsistency(manifests);
    process.exitCode = 1;
    return;
  }

  const current = manifests[0].version;
  const tagged = await tagExists(current);
  console.log(`统一版本 ${current}${tagged ? `（已有 tag v${current}）` : '（尚未打 tag）'}`);
}

/**
 * 计入「行为变更」的路径：apps / packages 下的源码与样式。
 * 测试文件、工具脚本、配置、文档都不计入 —— 它们不改变产品行为，按 semver 不该推进版本。
 */
const BEHAVIOR_PATH = /^(apps|packages)\/[^/]+\/.*\.(ts|tsx|css)$/;
const TEST_PATH = /(^|\/)(test\/|.*\.test\.tsx?$)/;

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: ROOT });
  return stdout;
}

/**
 * 该文件的暂存 diff 是否只动了注释与空白。
 *
 * 路径判据（`BEHAVIOR_PATH`）只认得出「碰了源码文件」，而版本规则的口径是「有没有改变
 * 产品行为」—— 补一句注释命中路径却不动行为，不该推进版本。这里补上这半边。
 *
 * 判据是**整个文件**的增删行都落在注释与空白上：任何一行真代码都会让它退回「行为变更」。
 * 新增文件一律算行为变更 —— 一个只有注释的新文件也是新模块。
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

async function isCommentOnlyChange(file) {
  const diff = await git(['diff', '--cached', '-U0', '--', file]);
  if (/^new file mode/m.test(diff)) return false;

  const changed = diff
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line))
    .map((line) => line.slice(1));

  if (changed.length === 0) return false;
  return changed.every((line) => line.trim().length === 0 || COMMENT_LINE.test(line));
}

/** 校验暂存区：有行为变更就必须同时有版本变更；两者都没有则放行。 */
async function cmdCheckStaged() {
  const staged = (await git(['diff', '--cached', '--name-only']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (staged.length === 0) {
    console.log('暂存区为空，跳过检查');
    return;
  }

  const candidates = staged.filter((f) => BEHAVIOR_PATH.test(f) && !TEST_PATH.test(f));

  const behaviorChanged = [];
  const commentOnly = [];
  for (const file of candidates) {
    if (await isCommentOnlyChange(file)) commentOnly.push(file);
    else behaviorChanged.push(file);
  }

  const manifestFiles = staged.filter((f) => f.endsWith('package.json'));

  let versionChanged = false;
  if (manifestFiles.length > 0) {
    const diff = await git(['diff', '--cached', '-U0', '--', ...manifestFiles]);
    versionChanged = /^[+-][ \t]*"version"/m.test(diff);
  }

  if (behaviorChanged.length > 0 && !versionChanged) {
    console.error('暂存区有行为变更，但没有同步推进版本号：\n');
    for (const f of behaviorChanged.slice(0, 10)) console.error(`  ${f}`);
    if (behaviorChanged.length > 10) console.error(`  … 另有 ${behaviorChanged.length - 10} 个文件`);
    console.error('\n修复：node scripts/version.mjs bump patch   # 或 minor / major，见 VERSIONING.md');
    process.exitCode = 1;
    return;
  }

  if (versionChanged && behaviorChanged.length === 0) {
    console.log('提醒：本次只改了版本号，没有行为变更 —— 确认这次 bump 是必要的。');
    return;
  }

  if (!versionChanged) {
    const detail =
      commentOnly.length > 0
        ? `（${commentOnly.length} 个源码文件仅注释变化）`
        : '（仅文档/测试/工具）';
    console.log(`暂存区无行为变更${detail}，无需推进版本号`);
    return;
  }

  console.log(`版本变更与行为变更一致（${behaviorChanged.length} 个源码文件）`);
}

async function cmdCheck(flags) {
  if (flags.has('--staged')) {
    await cmdCheckStaged();
    return;
  }

  const { manifests, versions } = await readAll();

  if (versions.size !== 1) {
    reportInconsistency(manifests);
    process.exitCode = 1;
    return;
  }

  const current = manifests[0].version;
  const tagged = await tagExists(current);

  if (tagged === true) {
    console.error(`版本号未推进：${current} 已经打过 tag v${current}。`);
    console.error('本次提交若含代码改动，先跑：node scripts/version.mjs bump patch');
    process.exitCode = 1;
    return;
  }

  console.log(`版本号校验通过：${manifests.length} 个清单统一为 ${current}`);
}

async function cmdSet(target) {
  if (!SEMVER.test(target)) {
    throw new Error(`目标版本不是 x.y.z 格式: ${target}`);
  }

  const { manifests } = await readAll();
  const changed = [];
  for (const m of manifests) {
    if (await writeVersion(m, target)) {
      changed.push(`${m.version} → ${target}  ${m.rel}`);
    }
  }

  if (changed.length === 0) {
    console.log(`无需改动：${manifests.length} 个清单已经是 ${target}`);
    return;
  }

  console.log(`已设定为 ${target}（${changed.length}/${manifests.length} 个清单）：`);
  for (const line of changed) console.log(`  ${line}`);
}

async function cmdBump(kind) {
  const { manifests, versions } = await readAll();

  if (versions.size !== 1) {
    reportInconsistency(manifests);
    process.exitCode = 1;
    return;
  }

  const current = manifests[0].version;
  const next = bumpVersion(current, kind);

  const changed = [];
  for (const m of manifests) {
    if (await writeVersion(m, next)) changed.push(m.rel);
  }

  console.log(`${current} → ${next}（${kind}，${changed.length} 个清单）`);
  console.log();
  console.log('下一步：把版本改动与代码改动放进同一个提交，然后打 tag：');
  console.log(`  git add -A && git commit -m "fix(scope): ..." && git tag v${next}`);
}

function usage() {
  console.log(`Nexus 版本号工具

  node scripts/version.mjs show              打印当前版本与各清单一致性
  node scripts/version.mjs check             校验一致性（版本已打 tag 时失败）
  node scripts/version.mjs check --staged    校验暂存区：源码变更是否伴随版本变更
  node scripts/version.mjs bump <kind>       推进版本：patch | minor | major
  node scripts/version.mjs set <x.y.z>       直接设定版本

版本推进规则见 VERSIONING.md。`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const argument = rest.find((arg) => !arg.startsWith('--'));

try {
  switch (command) {
    case 'show':
      await cmdShow();
      break;
    case 'check':
      await cmdCheck(flags);
      break;
    case 'bump':
      await cmdBump(argument ?? '');
      break;
    case 'set':
      await cmdSet(argument ?? '');
      break;
    default:
      usage();
      if (command !== undefined && command !== 'help' && command !== '--help' && command !== '-h') {
        process.exitCode = 1;
      }
  }
} catch (err) {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
