/**
 * 按当前输入的地址过滤候选图片。
 *
 * 图片选择器的列表**不是**「整个工作区有什么图」，而是「当前这条引用写的是什么，就列什么」——
 * 用户在源码里改地址时列表跟着变，于是它是自动补全，不是一个要自己翻的相册。
 *
 * 判据按优先级（数值越小越靠前）：
 * 1. 文件名以输入开头（`MA` → `MAIN.png`）—— 最接近「正在打的就是它」
 * 2. 路径以输入开头（`assets/` → `assets/x.png`）
 * 3. 输入落在某个目录段上（`assets/` → `../assets/x.png`）
 * 4. 文件名包含输入（`ain` → `MAIN.png`）—— 兜底，开头打错也能捞回来
 * 5. 路径包含输入
 *
 * 输入为空返回全部：那正是「想看有什么」的时刻。判据只做**子串/前缀**匹配，
 * 不做模糊打分 —— 地址是路径，用户知道自己在打什么，猜错比不猜更烦。
 */
import type { WorkspaceImageOption } from './types.js';

/**
 * 这次编辑写的是哪种地址。
 *
 * 两种写法的**路径段**不同（`![](…)` 相对文档目录、`![[…]]` 是 Obsidian 的最短唯一路径），
 * 所以过滤与预选都得按同一种去比 —— 拿文档目录相对的串去匹配嵌入档的裸名，一条都命不中。
 */
export type ImageAddressStyle = 'document' | 'wiki';

function addressOf(item: WorkspaceImageOption, style: ImageAddressStyle): string {
  return style === 'wiki' ? item.wikiPath : item.path;
}

/** 归一到可比较的形状：小写、正斜杠、去掉开头的 `./`（两种写法指同一处）。 */
function normalizeQuery(query: string): string {
  let normalized = query.trim().toLowerCase().replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function rankOf(item: WorkspaceImageOption, query: string, style: ImageAddressStyle): number {
  const name = item.name.toLowerCase();
  const path = addressOf(item, style).toLowerCase();
  if (name.startsWith(query)) return 0;
  if (path.startsWith(query)) return 1;
  if (path.includes('/' + query)) return 2;
  if (name.includes(query)) return 3;
  if (path.includes(query)) return 4;
  return -1;
}

/**
 * 过滤候选图片。
 *
 * 只做过滤、不改顺序语义：同优先级内保持 `items` 原本的次序（`Array.prototype.sort`
 * 在 ES2019 之后稳定），所以宿主怎么排、列表就怎么排。
 */
export function filterImageOptions(
  items: readonly WorkspaceImageOption[],
  query: string,
  style: ImageAddressStyle = 'document'
): WorkspaceImageOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...items];

  const matched: { item: WorkspaceImageOption; rank: number }[] = [];
  for (const item of items) {
    const rank = rankOf(item, normalized, style);
    if (rank >= 0) matched.push({ item, rank });
  }
  matched.sort((left, right) => left.rank - right.rank);
  return matched.map((entry) => entry.item);
}

/**
 * 这一张是不是当前引用写着的地址。
 *
 * 列表里的「预选」：地址完整时它只会命中一条，那条就是当前用的图 —— 标出来，
 * 用户一眼知道"现在指向的是哪张"，不用去比对文件名。
 *
 * 两边都归一化再比：`./pic.png` 与 `pic.png` 是同一个位置，写法的差别不该影响判断。
 * 地址为空或写了一半时恒 `false` —— 那正是"还没指向任何一张"。
 */
export function isCurrentImageOption(
  item: WorkspaceImageOption,
  query: string,
  style: ImageAddressStyle = 'document'
): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return false;
  return normalizeQuery(addressOf(item, style)) === normalized;
}
