/**
 * 扫描工作区时「哪些目录不看」的**唯一事实源**。
 *
 * 它住在 core 而不是主进程：规则是**纯字符串判断**，而设置页要能把「用户填的这一串」
 * 归一化成规则表 —— 两处各判一次的话，「设置页显示 `drafts`、实际没跳过」这种错不会报错。
 * 与 `document/extensions.ts` 是同一个理由（那边注释里写着同一句话）。
 *
 * 匹配只做**目录**，不做文件：跳过一个目录，它的整棵子树就都不进索引、也不进文件树
 * （文件树是索引的投影）。所以不需要前缀匹配 —— 命中即整棵剪掉。
 */

/**
 * 一律跳过的非点开头目录名。**用户不能取消**。
 *
 * 点开头的目录不在这里列举，由 `startsWith('.')` 一律跳过。它们几乎全是工具元数据：
 * `.git` / `.svn` / `.hg` / `.obsidian` / `.cache`，本应用自己的 `.nexus/history/`
 * （存的是快照不是文档），以及别的笔记工具留下的 `.marking/snapshots/`、
 * `.nestnote/trash/`。
 *
 * **改成前缀判定是因为逐个列举必然漏。** 实测一个真实工作区的索引里有 97 个文档，
 * 其中 12 个来自 `.marking` 与 `.nestnote` —— 那是别的工具的**快照和回收站**，却进了
 * 搜索、标签、图谱和文件树。逐个补名字只能等下一次踩坑。
 */
export const BUILT_IN_IGNORED_DIRECTORY_NAMES: readonly string[] = [
  'node_modules',
  'dist',
  'out',
  'build'
];

/** 一段路径里不该出现的分段：`.` 或 `..`（路径穿越写法，做忽略规则没有意义）。 */
function hasTraversalSegment(rule: string): boolean {
  return rule.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * 把用户在设置里填的一串文本归一化成规则表。
 *
 * 分隔符同时认**逗号与换行**：控件现在是单行输入框（用逗号），但用户从别处粘一段
 * 一行一条的清单是常事，不认换行就会把整段当成一条永远匹配不上的规则 —— 而它
 * **静默失效**，用户只会觉得「填了没用」。
 *
 * 归一化包含：反斜杠转正斜杠（Windows 用户会顺手敲 `\`）、去掉 `./` 与首尾 `/`、
 * **合并重复斜杠**（`notes//private` 是写法噪声，不是路径穿越）、丢掉盘符前缀、
 * 丢掉含 `.` / `..` 段的规则、大小写不敏感去重（保留第一次出现的写法，
 * 用户看到的是自己写的样子）。
 */
export function parseIgnoreRules(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];

  const rules: string[] = [];
  const seen = new Set<string>();

  for (const piece of raw.split(/[,\n\r]+/)) {
    let rule = piece.trim().replace(/\\/g, '/');
    // 盘符前缀：忽略规则永远相对工作区根，`C:/x` 只会让人以为写了绝对路径就能生效。
    rule = rule.replace(/^[A-Za-z]:\//, '');
    rule = rule.replace(/^\.\//, '');
    // 合并重复斜杠要排在去掉首尾斜杠**之前**：`notes//private/` 去掉尾部之后
    // 还剩中间那对，不合并就会被当成空段整条丢掉。
    rule = rule.replace(/\/{2,}/g, '/');
    rule = rule.replace(/^\/+/, '').replace(/\/+$/, '');

    if (rule === '' || hasTraversalSegment(rule)) continue;

    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }

  return rules;
}

/**
 * 这个目录该不该跳过扫描。
 *
 * `relativePath` 是**该目录相对工作区根**的路径，`/` 分隔、无前导斜杠（顶层目录时
 * 与 `name` 相同）。规则里带 `/` 就按相对路径比，不带就按目录名比 ——
 * 于是 `drafts` 命中任意层级的 `drafts/`，而 `notes/private` 只命中工作区根下的那一条。
 *
 * **匹配大小写不敏感。** 与仓库其余路径判断一致（`toPathKey` 与 `path.win32.relative`
 * 都是这个口径），代价是在大小写敏感的机器上 `Dist` 也会被当成 `dist` 跳过 ——
 * 那正是用户敲 `dist` 时想要的结果。内置名单因此也走同一条口径，避免「用户规则不敏感、
 * 内置规则敏感」这种没法解释的差别。
 */
export function shouldIgnoreDirectory(
  name: string,
  relativePath: string,
  userRules: readonly string[]
): boolean {
  if (name.startsWith('.')) return true;

  const lowerName = name.toLowerCase();
  if (BUILT_IN_IGNORED_DIRECTORY_NAMES.some((built) => built === lowerName)) return true;

  const lowerRelative = relativePath.toLowerCase();
  return userRules.some((rule) =>
    rule.includes('/') ? rule.toLowerCase() === lowerRelative : rule.toLowerCase() === lowerName
  );
}
