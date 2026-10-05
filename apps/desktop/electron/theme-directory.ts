/**
 * 用户主题目录：`<home>/.nexus/themes/`。**主题本体的落点**。
 *
 * ## 为什么是目录
 *
 * 出厂表收录哪几套 base16 主题是**构建期**的产品决策（`packages/theme/scripts/import-schemes.mjs`
 * 的 `FAMILIES` 白名单，53 族），而上游有一百多个族。没有这个目录时，用户手上白名单外的配色
 * 只能一套套粘进粘贴框；这个目录一开，`git clone` 上游 schemes 仓库就能直接用。
 *
 * ## 四条判据
 *
 * 1. **一个文件一版。** base16 scheme 天然只有 `variant` 一个值，明暗两面就是两个文件；
 *    「同一套主题的两面」由**文件里写的 `nexus.id`** 串起来（见 `@nexus/theme` 的
 *    `theme-file.ts`）。不发明「一个文件两版」的格式 —— 那会让上游的文件不能直接放进来。
 * 2. **没有 `nexus.id` 的文件，id 从文件名推**；**Nexus 写出去的一定带 `nexus.id`**。
 *    这样上游文件（无 id）能直接放进来，而 Nexus 自己的主题改文件名也不会丢掉身份 ——
 *    id 是选择的锚，文件名是用户的东西。
 * 3. **坏文件标出来，不忽略整库。** 一个手改坏的文件不该让其余主题一起消失，也不该静默跳过
 *    （用户会以为「Nexus 不认我的文件」）。与存档那边的口径相反：那里是「读一份存档」，
 *    坏一条丢掉即可；这里是「列一个目录」，每一份都要有交代。
 * 4. **目录不存在是常态。** 从没放过主题文件的用户，这个目录**根本不存在** —— 不是错误，
 *    返回空表。单文件读不动（权限、是目录、符号链接、太大）也只让那一个文件进 `broken`。
 *
 * ## 不 import electron
 *
 * 收 `directory` 而不是自己去问 `app.getPath('home')`，整个模块因此是纯 node —— 测试拿一个
 * 临时目录就能覆盖全部行为，包括坏文件方向与写出方向，不必启动窗口（与 `recent-workspace.ts`
 * 同一个做法）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  base16Slug,
  parseThemeFile,
  serializeThemeFile,
  THEME_FILE_EXTENSIONS,
  USER_THEME_PREFIX,
  userThemeBaseName,
  userThemeName,
  userThemeVariants,
  type NexusThemeScheme,
  type UserTheme
} from '@nexus/theme';
import type { BrokenThemeFile, BrokenThemeReason, ThemeSyncResult } from '../ipc/channels.js';

export const THEME_DIRECTORY_NAME = 'themes';

/**
 * 单文件上限 64KB。十六行 hex 的主题文件是一两 KB —— 超过这个量级的多半不是主题文件
 * （用户把别的东西放进来了），读它只是白费一次 IO。
 */
const MAX_THEME_FILE_BYTES = 64 * 1024;

export interface ThemeDirectoryScan {
  themes: UserTheme[];
  broken: BrokenThemeFile[];
}

/** 主题目录的绝对路径。`home` 由调用方给（主进程传 `os.homedir()`），测试传临时目录。 */
export function themeDirectoryPath(home: string): string {
  return path.join(home, '.nexus', THEME_DIRECTORY_NAME);
}

/**
 * 文件名（去扩展名的部分）→ 主题 id。**只对没有 `nexus.id` 的文件用。**
 *
 * `@` 必须换掉：选择格式是 `<预设>@<模式>`，id 里再出现一个 `@` 会让 `parseSelection` 从错误的
 * 位置切开。这是唯一一处对用户输入的改写，其余字符原样保留 —— 文件名是用户的东西。
 */
export function themeIdFromFileStem(stem: string): string {
  return USER_THEME_PREFIX + stem.replace(/@/g, '-');
}

/**
 * 扫一遍目录。**不抛** —— 目录不存在、读不动、单个文件坏掉，都只是结果里的一部分。
 *
 * 同 id 同变体的第二份文件进 `broken`（`duplicate-variant`）而不是覆盖第一份：两份都能读、
 * 却只有一个能生效时，「哪份生效」取决于文件系统给的顺序 —— 那是不可预测的。
 */
export function scanThemeDirectory(directory: string): ThemeDirectoryScan {
  const { themes, broken } = readThemeDirectory(directory);
  return { themes, broken };
}

interface DirectoryEntry {
  fileName: string;
  id: string;
  scheme: NexusThemeScheme;
}

interface DirectoryRead {
  themes: UserTheme[];
  broken: BrokenThemeFile[];
  files: DirectoryEntry[];
}

function readThemeDirectory(directory: string): DirectoryRead {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return { themes: [], broken: [], files: [] };
  }

  const byId = new Map<string, UserTheme>();
  const files: DirectoryEntry[] = [];
  const broken: BrokenThemeFile[] = [];

  // 排序后再读：坏文件里的「第二份」在两次扫描之间必须是同一个文件，否则「哪份生效」会飘。
  for (const name of [...names].sort()) {
    if (name.startsWith('.')) continue;
    const extension = path.extname(name).toLowerCase();
    if (!(THEME_FILE_EXTENSIONS as readonly string[]).includes(extension)) continue;

    const stem = name.slice(0, -extension.length);
    if (stem === '') continue;

    const read = readThemeFile(path.join(directory, name), stem);
    if (!read.ok) {
      broken.push({ fileName: name, reason: read.reason });
      continue;
    }

    const id = read.id ?? themeIdFromFileStem(stem);
    const existing = byId.get(id);
    if (existing?.variants[read.scheme.variant]) {
      broken.push({ fileName: name, reason: 'duplicate-variant' });
      continue;
    }

    byId.set(id, {
      id,
      variants: { ...existing?.variants, [read.scheme.variant]: read.scheme }
    });
    files.push({ fileName: name, id, scheme: read.scheme });
  }

  return { themes: [...byId.values()], broken, files };
}

type ThemeFileRead =
  | { ok: true; id: string | null; scheme: NexusThemeScheme }
  | { ok: false; reason: BrokenThemeReason };

/**
 * 读一个文件并解析。**符号链接与非常规文件一律拒** —— 一个指向别处的链接会让「目录里有什么」
 * 取决于链接指向哪，而它下次启动可能指向另一个地方。
 */
function readThemeFile(fullPath: string, stem: string): ThemeFileRead {
  let raw: string;
  try {
    const info = fs.lstatSync(fullPath);
    if (!info.isFile() || info.size > MAX_THEME_FILE_BYTES) {
      return { ok: false, reason: 'unreadable' };
    }
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const parsed = parseThemeFile(raw, stem);
  if (!parsed.ok) return { ok: false, reason: parsed.error.code };
  return { ok: true, id: parsed.id, scheme: parsed.scheme };
}

/**
 * 把一份主题列表**对齐到目录**：缺的文件写出来，多出来的删掉。
 *
 * ## `knownIds` 是必须的
 *
 * 它是「启动时那次扫描看到的 id」。只有落在它里面的文件才会被删 —— 否则用户刚放进目录、
 * 还没被读到的文件会被下一次同步顺手删掉。**会删数据的功能，失败方向必须选「不做」。**
 *
 * ## 不覆盖用户起的名字
 *
 * 一个主题已经有文件时**沿用那个文件名**（只有一个变体时连后缀都不动），新主题才去起名。
 * 为了「整齐」去重命名用户放进去的文件是白担风险。
 */
export function syncThemeDirectory(
  directory: string,
  themes: readonly UserTheme[],
  knownIds: readonly string[]
): ThemeSyncResult {
  const failed: string[] = [];
  let written = 0;
  let removed = 0;

  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return { written: 0, removed: 0, failed: [directory] };
  }

  const current = readThemeDirectory(directory);
  const reserved = new Set(current.files.map((file) => file.fileName.toLowerCase()));
  const wanted = new Set(themes.map((theme) => theme.id));

  for (const theme of themes) {
    const mine = current.files.filter((file) => file.id === theme.id).map((file) => file.fileName);
    const plan = planFileNames(theme, mine, reserved);

    for (const [variant, fileName] of plan) {
      const scheme = theme.variants[variant];
      if (!scheme) continue;
      try {
        fs.writeFileSync(path.join(directory, fileName), serializeThemeFile(theme.id, scheme), 'utf8');
        written += 1;
        reserved.add(fileName.toLowerCase());
      } catch {
        failed.push(fileName);
      }
    }

    const keep = new Set([...plan.values()].map((name) => name.toLowerCase()));
    for (const fileName of mine) {
      if (keep.has(fileName.toLowerCase())) continue;
      if (removeFile(directory, fileName)) removed += 1;
      else failed.push(fileName);
    }
  }

  // 只删「启动时就见过、现在不在列表里」的文件 —— 见上面 `knownIds` 那段。
  const known = new Set(knownIds);
  for (const file of current.files) {
    if (wanted.has(file.id) || !known.has(file.id)) continue;
    if (removeFile(directory, file.fileName)) removed += 1;
    else failed.push(file.fileName);
  }

  return { written, removed, failed };
}

/**
 * 这套主题该落成哪几个文件。返回 `变体 → 文件名`。
 *
 * 单变体且已有一个文件时**原样沿用** —— 手写一个 `dracula.yaml` 放进来、在 Nexus 里改一下，
 * 不该变成 `dracula.dark.yaml`。多出来一个变体时才需要按变体分文件。
 */
function planFileNames(
  theme: UserTheme,
  existing: readonly string[],
  reserved: ReadonlySet<string>
): Map<'light' | 'dark', string> {
  const variants = userThemeVariants(theme);
  const plan = new Map<'light' | 'dark', string>();

  if (variants.length === 1 && existing.length === 1) {
    plan.set(variants[0] as 'light' | 'dark', existing[0] as string);
    return plan;
  }

  const stem = sharedStem(existing) ?? uniqueStem(fileStem(theme), reserved);
  for (const variant of variants) plan.set(variant, `${stem}.${variant}.yaml`);
  return plan;
}

/**
 * 新文件的词干：主题名的**基名**（`Ayu Dark` / `Ayu Light` 都取 `Ayu`）slug 化。
 *
 * 取基名而不是整名，是为了让「明暗两版」落成 `ayu.dark.yaml` + `ayu.light.yaml` 而不是
 * `ayu-dark.dark.yaml` —— 后者看着像两台不同的机器生成的东西。而且加了第二版时词干不变，
 * 已有的那个文件不用改名。
 */
function fileStem(theme: UserTheme): string {
  return base16Slug(userThemeBaseName(userThemeName(theme)));
}

/** 已有文件名里共用的那个「不带变体后缀」的词干。没有已有文件时是 `null`。 */
function sharedStem(existing: readonly string[]): string | null {
  const first = existing[0];
  if (!first) return null;
  const stem = first.slice(0, -path.extname(first).length);
  const stripped = stem.replace(/\.(light|dark)$/i, '');
  return stripped === '' ? stem : stripped;
}

/** `name` → `name-2` → `name-3`… 直到不与目录里已有的名字冲突。 */
function uniqueStem(base: string, reserved: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const stem = index === 1 ? base : `${base}-${index}`;
    const taken = ['.yaml', '.yml'].some((extension) =>
      reserved.has(`${stem}.light${extension}`) ||
      reserved.has(`${stem}.dark${extension}`) ||
      reserved.has(`${stem}${extension}`)
    );
    if (!taken) return stem;
  }
}

/** 删文件。删不掉（占用 / 权限）返回 `false`，由调用方报出去 —— 静默的删除失败同样是撒谎。 */
function removeFile(directory: string, fileName: string): boolean {
  try {
    fs.unlinkSync(path.join(directory, fileName));
    return true;
  } catch {
    return false;
  }
}
