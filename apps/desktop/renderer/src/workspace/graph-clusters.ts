/**
 * 图谱的**分区**：按文档所在的顶层目录分组，每组一个颜色。
 *
 * ## 颜色来自主题里**图谱自己那一组** token
 *
 * `--nexus-graph-1..8` 由主题系统派生（`packages/theme/src/derive.ts` 的 `GRAPH_RULES`），
 * 三个理由：
 *
 * 1. 它们是 base16 的八个**色相槽**（`base08`–`base0F`），所以对**任何**主题都成立 ——
 *    内置两套、105 套预设、用户自己的主题，全都自带这八个槽。
 * 2. 明暗两版的值由主题给出，这里**不需要判断当前是深色还是浅色** ——
 *    画布读 CSS 变量时拿到的已经是当前主题的值。
 * 3. 主题换掉时图谱跟着换，不会留下第三套配色。
 *
 * 为什么不是继续借 `syntax-*`（这一组出现之前是那么做的）：语法高亮只占用了八个色相槽里的
 * 六个（`base09` / `base0A` 归 `status-warning-*`），所以借来的那六个**凑不出第八个** ——
 * 顶层目录一到七个就会撞上「其他」那一行。专属 token 让「还差两个」这件事有地方说。
 *
 * 顺序沿用了借 `syntax-*` 时期的**槽位顺序**，所以 ≤6 个分区的工作区不会整体换色
 * （唯一的例外在暗色主题的第三个槽位，见 `derive.ts` 的 `GRAPH_RULES`）。
 *
 * ## 为什么是「按大小排名分配」而不是「按名字 hash」
 *
 * hash 能保证「同一个分区名永远同一个颜色」，但**会撞色** —— 而图例一旦出现两个分区
 * 共用一个色块，它就是在说谎。排名分配在不超过调色板大小时**必然不撞**。
 *
 * 排名按文档数降序（同数按名字）：颜色是稀缺资源，给最大的那几个分区最有用。
 * 代价是某个分区变大变小可能让它换色 —— 权衡下来选不撞色：**颜色变了用户看得见，
 * 颜色撞了看不见**。
 *
 * 第 9 个及以后的分区共用一个中性色，图例里合并成一行「其他」——
 * 不这么做的话，图例只能显示 8 行，而屏幕上还有颜色对不上的分区。
 */
export const CLUSTER_TOKENS = [
  '--nexus-graph-1',
  '--nexus-graph-2',
  '--nexus-graph-3',
  '--nexus-graph-4',
  '--nexus-graph-5',
  '--nexus-graph-6',
  '--nexus-graph-7',
  '--nexus-graph-8'
] as const;

/** 拿不到颜色的分区（第 9 个及以后、以及根目录下的文档）用的中性色。 */
export const UNCLUSTERED_TOKEN = '--nexus-text-muted';

/**
 * 文档所在的分区 = **顶层目录名**；根目录下的文档没有分区（返回 `null`）。
 *
 * 选顶层目录而不是「frontmatter 里的 cluster 字段」：后者要引入「用户自定义键」这个概念，
 * 而顶层目录零成本、且对绝大多数工作区就是用户心里的分区。
 */
export function clusterOf(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/');
  const slash = normalized.indexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : null;
}

/**
 * 分区按「文档数降序、同数按名字」排名。
 *
 * 排名同时决定两件事：谁拿到调色板颜色、图例按什么顺序列。**必须是同一份实现** ——
 * 图例按一种顺序列、颜色按另一种顺序发的话，色块和名字会对不上，而那种错法看起来
 * 只是「图例有点乱」。
 */
export function rankClusters(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .sort(([nameA, countA], [nameB, countB]) =>
      countA === countB ? nameA.localeCompare(nameB) : countB - countA
    )
    .map(([name]) => name);
}

/**
 * 分区名 → 调色板下标（`null` 表示共用中性色）。
 *
 * 输入是「分区 → 文档数」，输出覆盖输入里出现的每一个分区。
 */
export function assignClusterSlots(
  counts: ReadonlyMap<string, number>
): Map<string, number | null> {
  const slots = new Map<string, number | null>();
  rankClusters(counts).forEach((name, index) => {
    slots.set(name, index < CLUSTER_TOKENS.length ? index : null);
  });
  return slots;
}

/** 图例上最多列几行分区色块 —— 与调色板同宽，多出来的都归到「其他」。 */
export const LEGEND_MAX_ROWS = CLUSTER_TOKENS.length;
