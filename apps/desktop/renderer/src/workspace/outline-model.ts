/**
 * 大纲的**折叠**：把扁平的标题列表算成「哪些项可见、哪些项有可折叠的子孙」。
 *
 * ## 为什么不建树
 *
 * 渲染层本来就是扁平 `<ul>` + 缩进（见 `App.css` 的 `.nexus-outline-row`），
 * 而「某个标题属于谁」在按文档顺序排列的标题列表里是**可以就地推出来**的：
 * 子孙紧跟在祖先后面、层级更深。建树要重写渲染与键盘导航，换不来任何东西。
 *
 * ## key 里不能有数组下标
 *
 * 用 `层级:文本:同名序号`，不用下标。大纲**实时跟随编辑** —— 在文档中间插一个标题，
 * 后面所有项的下标都会平移，带下标的 key 会把折叠状态错位到别的标题上（用户折叠了
 * 「常见问题」，插入一行之后变成「安装」折着）。
 *
 * 序号只用来区分**同名同层级**的标题；改标题文字会丢掉那一项的折叠状态，这是接受的代价
 * （要保住得做标题身份的模糊匹配，代价远大于收益）。
 */
import type { OutlineHeading } from './outline.js';

export interface OutlineRenderItem {
  heading: OutlineHeading;
  /** 在**完整**标题列表里的下标。过滤与折叠都不改变它。 */
  index: number;
  /** 折叠状态的键。文档内容变化时保持稳定，见文件头。 */
  key: string;
  /** 是否存在**可见的**更深层级标题。为 `false` 时不画折叠三角。 */
  hasChildren: boolean;
}

/**
 * 某一层级是否落在「可见范围」内。`maxLevel` 为 `null` 表示不过滤。
 *
 * 抽出来是因为它同时决定两件事：丢掉哪些项、以及某一项该不该画折叠三角。
 * 两者必须同源 —— 否则会出现「折叠三角指向一个已被过滤掉的子项」，点下去什么都不发生。
 */
function isVisibleLevel(level: number, maxLevel: number | null): boolean {
  return maxLevel === null || level <= maxLevel;
}

/** 从 `index` 往后扫，遇到层级不深于自己的标题就停（那一节已经结束了）。 */
function hasVisibleChildren(
  headings: OutlineHeading[],
  index: number,
  maxLevel: number | null
): boolean {
  const item = headings[index];
  if (!item) return false;

  for (let next = index + 1; next < headings.length; next += 1) {
    const candidate = headings[next];
    if (!candidate) continue;
    if (candidate.level <= item.level) return false;
    if (isVisibleLevel(candidate.level, maxLevel)) return true;
  }

  return false;
}

/** 给每个标题算一个稳定身份，同名同层级按出现次序区分。 */
function outlineItemKeys(headings: OutlineHeading[]): string[] {
  const seen = new Map<string, number>();

  return headings.map((heading) => {
    const base = `${heading.level}:${heading.text}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}#${occurrence}`;
  });
}

/** 加上 `hasChildren`，并丢掉超出 `maxLevel` 的项。`index` 仍是原列表里的下标。 */
export function buildOutlineRenderItems(
  headings: OutlineHeading[],
  maxLevel: number | null = null
): OutlineRenderItem[] {
  const keys = outlineItemKeys(headings);

  return headings.flatMap((heading, index) => {
    if (!isVisibleLevel(heading.level, maxLevel)) return [];

    return [
      {
        heading,
        index,
        key: keys[index]!,
        hasChildren: hasVisibleChildren(headings, index, maxLevel)
      }
    ];
  });
}

/**
 * 当前所处的标题：**最后一个起始偏移不晚于 `position` 的标题**。
 *
 * `position` 由调用方给（光标偏移，或视口中线对应的文档位置），所以这个函数对
 * 「跟光标」还是「跟滚动」是中立的 —— 那是调用方选的口径，不是大纲结构的性质。
 *
 * 返回 `null` 表示 `position` 落在第一个标题之前（比如光标停在文首的前言里）——
 * 这时**不该高亮任何一项**，硬指一个会让人以为自己在那一节里。
 */
export function resolveActiveHeadingOffset(
  headings: OutlineHeading[],
  position: number
): number | null {
  let active: number | null = null;

  for (const heading of headings) {
    if (heading.offset > position) break;
    active = heading.offset;
  }

  return active;
}

/**
 * 滤掉被折叠项的所有子孙。
 *
 * 只需要一个「当前被折叠的祖先层级」游标：扁平列表里，被折叠那一节的子孙全都紧跟在它后面
 * 且层级更深，扫到层级不深于它的项就说明这一节结束了。被祖先挡住的项**不更新游标** ——
 * 它还在那一节里面。
 */
export function visibleOutlineRenderItems(
  items: OutlineRenderItem[],
  collapsedKeys: ReadonlySet<string>
): OutlineRenderItem[] {
  let collapsedAncestorLevel: number | null = null;

  return items.filter((item) => {
    const hiddenByAncestor =
      collapsedAncestorLevel !== null && item.heading.level > collapsedAncestorLevel;
    if (hiddenByAncestor) return false;

    collapsedAncestorLevel = collapsedKeys.has(item.key) ? item.heading.level : null;
    return true;
  });
}
