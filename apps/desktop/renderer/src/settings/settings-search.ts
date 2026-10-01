/**
 * 设置搜索：把敲进来的几个字，变成「哪一组的哪一项」。
 *
 * ## 索引三类条目，但**不建缓存**
 *
 * 分组、字段、别名三类都进候选（敲「快捷键」该跳到那一组，敲「暗色」该跳到「模式」那一项）。
 * 但这三类是**每次按键现算**的，没有一份常驻索引 —— 规模只有 8 个分组 + 35 个字段，
 * 一次全扫是微秒级；而缓存必须跟着**界面语言**失效（标签是翻译出来的），
 * 多一份失效逻辑换不来任何可感的收益。这条是判据，不是偷懒：等设置项涨到几百条再谈缓存。
 *
 * ## 权重
 *
 * 标签 > 别名 > id。用户敲的多半是屏幕上看得见的那几个字，那一项就该排在前面；
 * id（`appearance.themeMode`）排最后，因为它是一长串英文，模糊匹配下几乎任何字母序列
 * 都能在里面找到自己 —— 不压住的话，敲 `a` 会得到一屏 id 命中。
 *
 * ## 命中的是别名时，要能说出来
 *
 * 只给一个标签的话，「敲 dark 得到『模式』」看起来像撞运气。所以命中别名或 id 时把那一串
 * 原文一并带出去（`via`），由界面画在标签旁边。**`positions` 只在标签自己命中时非空** ——
 * 别名命中的下标对标签没有意义，拿它去高亮会错位。
 */

import { fuzzyMatch } from '../workspace/fuzzy.js';
import { FIELDS, SECTIONS, type FieldDef, type FieldTranslate, type SectionId } from './registry.js';

/**
 * 三类目标的权重。别名 0.85 而不是 1：标签与别名同时命中时，标签那一条该赢 ——
 * 用户敲的正是屏幕上那个词。
 */
const WEIGHT = { label: 1, keyword: 0.85, id: 0.45 } as const;

/** 结果条数上限。全部设置项也就四十来个，30 条已经约等于「几乎全列」。 */
export const SEARCH_LIMIT = 30;

export interface SettingsSearchHit {
  /** 渲染列表的 React key：`field:<id>` 或 `section:<id>`。 */
  key: string;
  /** 命中项所属分组。点击后要切到它。 */
  section: SectionId;
  /** 字段命中时的字段定义；**分组命中时为 `null`**（那一项没有可跳转的行）。 */
  field: FieldDef | null;
  /** 显示名，已按当前语言翻译。 */
  label: string;
  /** `label` 里命中的下标，供高亮。空数组 ＝ 标签自己没命中（命中的是别名或 id）。 */
  positions: readonly number[];
  /** 命中的别名 / id 原文，用来解释「为什么它在这」。标签命中时为 `null`。 */
  via: string | null;
  /** 排序用，不展示。 */
  score: number;
}

interface Target {
  text: string;
  weight: number;
  /** 这一条是不是显示名本身。只有它是时，命中位置才能拿去高亮标签。 */
  isLabel: boolean;
}

function bestOf(
  needle: string,
  targets: readonly Target[]
): { score: number; positions: number[]; via: string | null } | null {
  let best: { score: number; positions: number[]; via: string | null } | null = null;

  for (const target of targets) {
    if (target.text === '') continue;
    const match = fuzzyMatch(needle, target.text);
    if (!match) continue;

    const score = match.score * target.weight;
    // 严格大于：同分时保留**先到的**那一条。目标按 标签 → 别名 → id 排列，
    // 所以同分时留下的总是更靠前的那个 —— 分数并列却把标签的位置信息顶掉是最难查的一类错。
    if (best !== null && best.score >= score) continue;

    best = {
      score,
      positions: target.isLabel ? match.positions : [],
      via: target.isLabel ? null : target.text
    };
  }

  return best;
}

/**
 * 按查询串给设置项排序。空查询（或只有空白）返回空数组 —— 「什么都没敲」不该等于「列出全部」，
 * 那会让空搜索框看起来像一屏莫名其妙的清单。
 */
export function searchSettings(
  query: string,
  t: FieldTranslate,
  limit = SEARCH_LIMIT
): SettingsSearchHit[] {
  const needle = query.trim();
  if (needle === '') return [];

  const hits: SettingsSearchHit[] = [];

  for (const section of SECTIONS) {
    const label = t(section.titleKey);
    const best = bestOf(needle, [
      { text: label, weight: WEIGHT.label, isLabel: true },
      ...(section.keywords ?? []).map(
        (text): Target => ({ text, weight: WEIGHT.keyword, isLabel: false })
      )
    ]);
    if (!best) continue;

    hits.push({
      key: `section:${section.id}`,
      section: section.id,
      field: null,
      label,
      positions: best.positions,
      via: best.via,
      score: best.score
    });
  }

  for (const field of FIELDS) {
    const label = t(field.labelKey);
    const best = bestOf(needle, [
      { text: label, weight: WEIGHT.label, isLabel: true },
      ...(field.keywords ?? []).map(
        (text): Target => ({ text, weight: WEIGHT.keyword, isLabel: false })
      ),
      { text: field.id, weight: WEIGHT.id, isLabel: false }
    ]);
    if (!best) continue;

    hits.push({
      key: `field:${field.id}`,
      section: field.section,
      field,
      label,
      positions: best.positions,
      via: best.via,
      score: best.score
    });
  }

  // 分数降序。同分保持注册表顺序 —— `Array.prototype.sort` 自 ES2019 起保证稳定，
  // 所以「编辑器」那几个字号/行高不会在两次按键之间跳来跳去。
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
