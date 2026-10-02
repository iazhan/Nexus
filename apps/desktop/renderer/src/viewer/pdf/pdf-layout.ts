/**
 * PDF 阅读器的纯逻辑：缩放档位、滚轮缩放与锚点、适合宽度、可见页判定、大纲模型。
 *
 * 抽出来是因为这几件事都是**算出来的**，而它们的错法在画面上看不出来：
 * 缩放夹不住只会「按钮点了没反应」、可见页算错只会「页码停在上一页」、
 * 大纲层级算错只会「缩进少一层」、锚点算错只会「放大之后想看的那个地方跑掉了」。
 * 放在组件里它们只能靠真机截图去猜，放在这里每一条都能用一组数字钉死。
 */

/**
 * PDF 单位是 1/72 英寸，直接按 scale 1 渲染会明显偏小。
 *
 * **它不是「缩放」** —— 这是用户看到的 100% 对应的基准换算，用户可调的倍率乘在它上面。
 * 它同时是文本层的 `--scale-factor` 基准：两者必须是同一个数，否则选中的文字与画面上的
 * 字对不上（能选，但选偏）。
 */
export const BASE_SCALE = 1.5;

/** 缩放区间。下限留到 50% 是「看一眼整页版式」，上限 300% 是「看清一个小字号注释」。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;

/** 100% ＝ `BASE_SCALE`。存的是**倍率**不是最终 scale，`BASE_SCALE` 改了不影响这个值。 */
export const ZOOM_DEFAULT = 1;

/**
 * 还没读到任何一页时用的占位尺寸（A4，单位是 PDF 的 1/72 英寸）。
 *
 * 有它才不会出现「容器高 0 → 渲染完突然撑开」的跳动，而**取不到尺寸**是正常路径：
 * 首页的 `getPage` 可能失败，加密 PDF 更是要等口令。占位偏一点比抖一下好。
 */
export const A4_FALLBACK_SIZE = { width: 595, height: 842 } as const;

/**
 * 把任意数字夹进缩放区间。
 *
 * **非有限数回落 100%**：`NaN` / `Infinity` 都是算错了的产物（除零、没量到尺寸），
 * 而 `canvas.width = NaN` 不抛错、只是把画布设成 0 —— 症状是「缩放之后整页变白」。
 * 有限的越界值则**夹紧**而不是回落：`0.1` 是「想再小一点」的合理意图，夹到下限比
 * 跳回 100% 更贴近用户按下去时想要的东西。
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/**
 * 走一档。取两位小数是因为 `0.5 + 0.25 × 3` 在二进制里是 `1.2499999999999998` ——
 * 它会被原样显示成「125%」，而判定「到顶了没有」用的等号也会跟着失灵。
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const next = clampZoom(current) + direction * ZOOM_STEP;
  return clampZoom(Number(next.toFixed(2)));
}

/**
 * 缩放的百分比**数字部分**（不带 `%`）。
 *
 * 输入框用它而不是「带后缀的字符串」：把 `100%` 塞进 `value`，用户每次改数字都得先删掉
 * 那个 `%`。后缀由渲染层单独画一个 `<span>`，与输入框本身无关。
 *
 * 四舍五入到整数 —— 显示 `99.99999` 只会让人怀疑自己点错了。
 */
export function zoomPercent(scale: number): string {
  return String(Math.round(clampZoom(scale) * 100));
}

/**
 * 「适合宽度」对应的倍率。
 *
 * 入参是 **PDF 自己的页宽**（`viewport({ scale: 1 }).width`，1/72 英寸为单位）与容器的
 * **可用像素宽**（已扣掉内边距与滚动条，由调用方量好）。两者量纲不同，所以先乘
 * `BASE_SCALE` 换成 100% 时的像素宽，再比。
 *
 * 量不出来（容器还没布局、页宽为 0）时回落到 100% —— 回落到「适合宽度」的极限值
 * （`ZOOM_MIN` 或 `ZOOM_MAX`）会让窗口刚打开的一瞬间跳到最小或最大。
 */
export function fitWidthZoom(naturalWidth: number, availableWidth: number): number {
  const natural = naturalWidth * BASE_SCALE;
  if (!(natural > 0) || !(availableWidth > 0)) return ZOOM_DEFAULT;
  return clampZoom(availableWidth / natural);
}

/**
 * 连续滚动时「当前在第几页」。
 *
 * 判据与大纲面板同一条：**以视口顶部为准**，第一个还没越过的页就是当前页。
 * `tolerance` 是给「页顶刚滚出去一点点」留的余量 —— 没有它，页与页之间的间隙会让
 * 页码在交界处来回跳。
 *
 * `offsets` 是各页顶边相对滚动容器的偏移（1-based 的第 n 页在 `offsets[n - 1]`），
 * 必须**递增**。空数组返回 1：没有页可算时，「第 1 页」是唯一说得通的答案。
 */
export function pageAtScrollOffset(
  offsets: readonly number[],
  scrollTop: number,
  tolerance = 24
): number {
  let active = 1;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index];
    if (offset === undefined || offset > scrollTop + tolerance) break;
    active = index + 1;
  }
  return active;
}

/**
 * 把某一页滚进视野时要设的 `scrollTop`。
 *
 * **不用 `scrollIntoView`**：它会滚动所有可滚祖先（`overflow: hidden` 的照样被滚），
 * 在侧栏 + 页面的布局里会把整窗带走。这里只算目标容器自己的滚动位置。
 *
 * `inset` 是页顶留白：贴到容器最上沿会让页面紧贴工具栏，看着像被裁掉了。
 */
export function scrollOffsetForPage(offsetTop: number, inset = 8): number {
  return Math.max(0, offsetTop - inset);
}

/**
 * 滚轮一格大约 100，乘这个系数后每格约 1.1 倍 —— 再快就调不准。
 *
 * 与图谱面板**同值**：同一个应用里两处滚轮缩放的手感必须一致，各调各的迟早会漂。
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.001;

/**
 * 滚轮增量 → 缩放因子。向上滚（`deltaY < 0`）放大。
 *
 * 用指数而不是加法：连续滚 N 格的因子等于一格因子的 N 次方，于是「滚回去」必然回到
 * 原处。加法做不到这一点（每格加 0.1，滚到顶被夹住之后再滚回来就回不到原值）。
 *
 * 非有限数返回 1（不动）—— `deltaY` 是 `NaN` 的话因子会变成 `NaN`，而 `NaN` 一旦进了
 * `canvas.width` 就是把画布设成 0，症状是「缩放之后整页变白」。
 */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
}

/** 一页在滚动容器里的实测几何（`offsetTop` / `offsetHeight`，与内容坐标同原点）。 */
export interface PageSpan {
  readonly pageNumber: number;
  readonly top: number;
  readonly height: number;
}

/**
 * 内容坐标 `offset` 落在哪一页的哪个相对位置（0–1）。
 *
 * 滚轮缩放要「光标下那一点不动」，而**页与页之间的 `gap` 是固定像素、不随缩放变** ——
 * 所以内容坐标不是「整体乘一个比例」。按页的实测几何记下相对位置，缩放后重新落到
 * 同一相对位置上，才是准的。
 *
 * 光标落在页与页之间的间隙（或整列上下的留白）里时，取它上面最近的一页并把相对位置
 * 夹到 `[0, 1]` —— 直接返回 `null` 的话，光标恰好压在间隙上的那一次滚轮会完全不平移，
 * 看起来像卡了一下。
 */
export function pageFractionAt(
  spans: readonly PageSpan[],
  offset: number
): { pageNumber: number; fraction: number } | null {
  const usable = spans.filter((span) => span.height > 0);
  if (usable.length === 0) return null;

  for (const span of usable) {
    if (offset >= span.top && offset < span.top + span.height) {
      return { pageNumber: span.pageNumber, fraction: (offset - span.top) / span.height };
    }
  }

  let above: PageSpan | null = null;
  for (const span of usable) {
    if (span.top <= offset && (above === null || span.top > above.top)) above = span;
  }
  const fallback = above ?? usable[0];
  if (fallback === undefined) return null;
  const raw = (offset - fallback.top) / fallback.height;
  return { pageNumber: fallback.pageNumber, fraction: Math.min(1, Math.max(0, raw)) };
}

/**
 * 让某一页里的某个相对位置停在光标处的 `scrollTop`。
 *
 * 用**缩放后的实测几何**算，不用「旧位置 × 比例」：见 `pageFractionAt` 里 `gap` 那段。
 * 结果夹到 0 以上 —— 负的滚动位置没有意义，而让它流到调用方去，调用方就会拿它做算术。
 */
export function scrollTopForAnchor(
  pageTop: number,
  pageHeight: number,
  fraction: number,
  cursorOffset: number
): number {
  const value = pageTop + fraction * pageHeight - cursorOffset;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

/** pdfjs 的 `getOutline()` 节点形状（只取这里用得到的字段）。 */
export interface RawOutlineNode {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: readonly RawOutlineNode[];
}

/** 扁平化后的一项。`depth` 从 0 起 —— 渲染层拿它算缩进。 */
export interface OutlineEntry {
  readonly title: string;
  readonly depth: number;
  /** 页内目标，交给调用方用 `getPageIndex` / `getDestination` 解成页码。 */
  readonly dest: unknown;
}

/**
 * 大纲深度上限。
 *
 * 不是排版选择而是**防御**：大纲的嵌套层数由 PDF 自己决定，一份构造过的文件可以让它
 * 深到递归栈溢出 —— 而症状是「打开这份 PDF 就白屏」，用户无从判断是文件的问题。
 */
const MAX_OUTLINE_DEPTH = 8;

/**
 * 把 pdfjs 的大纲树拍平成一维列表，顺带算出层级。
 *
 * **拍平而不是留成树**：渲染要的是「按顺序一行一行画，每行按 `depth` 缩进」，
 * 树形结构到 JSX 里还得再递归一次，而递归渲染的展开状态是另一个要维护的东西。
 * 这一版不做折叠 —— 大纲本来就是用来一眼扫完的，折叠反而是多余的交互。
 *
 * 三类节点被丢掉，且都是刻意的：
 * - **没有 `title`**：画出来是一行空白，点了会跳页，用户看不出自己点了什么。
 * - **只有外链没有 `dest`**（`url` 形式的条目）：这里没有浏览器，点了跳不出去；
 *   画一个点了没反应的条目比不画更糟。
 * - **超过深度上限的子树**：见 `MAX_OUTLINE_DEPTH`。
 */
export function flattenOutline(
  nodes: readonly RawOutlineNode[] | null | undefined,
  depth = 0
): OutlineEntry[] {
  if (!Array.isArray(nodes) || depth >= MAX_OUTLINE_DEPTH) return [];

  const entries: OutlineEntry[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;

    const title = typeof node.title === 'string' ? node.title.trim() : '';
    const hasDest = node.dest !== undefined && node.dest !== null;
    if (title.length > 0 && hasDest) entries.push({ title, depth, dest: node.dest });

    // 即使父节点自己被丢掉，子树也要继续 —— 一个没标题的分组节点下面常常挂着
    // 一串正常条目，整棵丢掉会让大纲凭空少一段。
    if (Array.isArray(node.items) && node.items.length > 0) {
      entries.push(...flattenOutline(node.items, depth + 1));
    }
  }
  return entries;
}
