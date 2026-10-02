/**
 * 图谱节点的**标签避让布局**：给一批候选标签算出互不重叠的矩形。
 *
 * ## 为什么不是「把名字画在节点上」
 *
 * 直接在每个点旁边写字，节点一密就糊成一团 —— 而节点密度恰恰是图谱最需要读的东西。
 * 所以这里做的是**贪心放置**：按重要度排序，逐个挑一个不和已放标签、也不和任何节点圆
 * 相交的位置；四个锚点（下、上、右、左）都放不下就**放弃这个标签**，而不是硬塞。
 *
 * 放弃是刻意的代价：少画几个标签只是信息少一点，画重叠了则是**读不出来**。后者更糟。
 *
 * ## 坐标是**屏幕**坐标，不是图坐标
 *
 * 候选节点由调用方投影好再传进来（`screenX` / `screenY` / `radiusPx`）。
 * 这样画布缩放平移时只有调用方的投影要变，避让算法一个字不用改 —— 把投影塞进这里的话，
 * 缩放一变就得重算一套几何换算，而那正是最容易错的地方。
 *
 * ## 为什么必须确定性
 *
 * 排序里没有任何随机项，末位兜底用 `id` 比较。图谱每次打开、每次重排都得到同一份标签，
 * 用户才能靠位置记住「那篇文档在哪」；而且坐标可断言（随机排序只能测「跑完了没抛错」）。
 */
export interface GraphLabelCandidate {
  id: number;
  /** 屏幕坐标 */
  screenX: number;
  screenY: number;
  /** 屏幕上的节点半径 */
  radiusPx: number;
  text: string;
  isActive: boolean;
  /** 关联边数，决定重要度相同时谁先被放 */
  degree: number;
}

export interface GraphLabelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GraphLabelPlacement {
  id: number;
  text: string;
  isActive: boolean;
  /** 文本左上角（画的时候配 `textBaseline: 'top'`） */
  textX: number;
  textY: number;
  rect: GraphLabelRect;
}

export interface PlanGraphLabelsOptions {
  candidates: readonly GraphLabelCandidate[];
  viewport: { width: number; height: number };
  /** 最多画几个。**必须有上限** —— 否则量测开销会反超布局本身。 */
  maxLabels: number;
  /** 单条标签的最大文本宽度；超出的截断成 `…`。 */
  maxLabelWidthPx: number;
  measureTextWidth: (text: string) => number;
}

const FONT_SIZE_PX = 10;
const PADDING_X_PX = 4;
const PADDING_Y_PX = 3;
const HEIGHT_PX = FONT_SIZE_PX + PADDING_Y_PX * 2;
/** 标签与节点之间留的空隙 —— 贴着点画比不画更难读。 */
const GAP_PX = 3;
/** 标签矩形与**别的**节点圆之间额外留的空隙。 */
const NODE_CLEARANCE_PX = 2;
/** 距离比较的容差：屏幕坐标是浮点，直接比大小会让排序在等价情形下抖动。 */
const DISTANCE_EPSILON_PX = 0.001;
const ELLIPSIS = '…';

/** 锚点尝试顺序：优先往下（读起来最自然），放不下再依次换。 */
const ANCHORS = ['bottom', 'top', 'right', 'left'] as const;
type Anchor = (typeof ANCHORS)[number];

interface PlacedCandidate {
  candidate: GraphLabelCandidate;
  text: string;
  distanceToCenter: number;
}

export function planGraphLabels(options: PlanGraphLabelsOptions): GraphLabelPlacement[] {
  const { candidates, viewport, maxLabels, maxLabelWidthPx, measureTextWidth } = options;

  if (maxLabels <= 0 || viewport.width <= 0 || viewport.height <= 0) return [];

  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;

  const ordered = candidates
    .map<PlacedCandidate>((candidate) => ({
      candidate,
      text: clampToWidth(candidate.text, maxLabelWidthPx, measureTextWidth),
      distanceToCenter: Math.hypot(candidate.screenX - centerX, candidate.screenY - centerY)
    }))
    .filter((item) => item.text.length > 0)
    .sort(compareCandidates);

  const placements: GraphLabelPlacement[] = [];
  const takenRects: GraphLabelRect[] = [];

  for (const item of ordered) {
    if (placements.length >= maxLabels) break;

    const placement = place(item.text, item.candidate, {
      viewport,
      takenRects,
      nodes: ordered.map((entry) => entry.candidate),
      measureTextWidth
    });
    if (placement === null) continue;

    placements.push(placement);
    takenRects.push(placement.rect);
  }

  return placements;
}

/** 重要度：活跃文档 > 离中心近 > 度数高 > 名字短 > id。末位必须是**全序**，否则结果不确定。 */
function compareCandidates(a: PlacedCandidate, b: PlacedCandidate): number {
  if (a.candidate.isActive !== b.candidate.isActive) return a.candidate.isActive ? -1 : 1;
  if (Math.abs(a.distanceToCenter - b.distanceToCenter) > DISTANCE_EPSILON_PX) {
    return a.distanceToCenter - b.distanceToCenter;
  }
  if (a.candidate.degree !== b.candidate.degree) return b.candidate.degree - a.candidate.degree;
  if (a.text.length !== b.text.length) return a.text.length - b.text.length;
  return a.candidate.id - b.candidate.id;
}

/**
 * 给一个候选试四个锚点，返回第一个放得下的位置；都放不下返回 `null`。
 *
 * 判据是「在视口内」**且**「不和已放标签相交」**且**「不和任何**别的**节点圆相交」——
 * 最后一条漏掉的话，标签会盖住旁边的点，而点被盖住等于那条链接读不出来。
 */
function place(
  text: string,
  candidate: GraphLabelCandidate,
  context: {
    viewport: { width: number; height: number };
    takenRects: readonly GraphLabelRect[];
    nodes: readonly GraphLabelCandidate[];
    measureTextWidth: (text: string) => number;
  }
): GraphLabelPlacement | null {
  const boxWidth = context.measureTextWidth(text) + PADDING_X_PX * 2;
  if (boxWidth <= PADDING_X_PX * 2) return null;

  for (const anchor of ANCHORS) {
    const rect = rectFor(candidate, anchor, boxWidth);

    if (rect.left < 0 || rect.top < 0) continue;
    if (rect.right > context.viewport.width || rect.bottom > context.viewport.height) continue;
    if (context.takenRects.some((taken) => rectsIntersect(taken, rect))) continue;
    if (
      context.nodes.some(
        (node) =>
          node.id !== candidate.id &&
          rectIntersectsCircle(rect, node.screenX, node.screenY, node.radiusPx + NODE_CLEARANCE_PX)
      )
    ) {
      continue;
    }

    return {
      id: candidate.id,
      text,
      isActive: candidate.isActive,
      textX: rect.left + PADDING_X_PX,
      textY: rect.top + PADDING_Y_PX,
      rect
    };
  }

  return null;
}

function rectFor(candidate: GraphLabelCandidate, anchor: Anchor, boxWidth: number): GraphLabelRect {
  const halfWidth = boxWidth / 2;
  const halfHeight = HEIGHT_PX / 2;

  let left = candidate.screenX - halfWidth;
  let top = candidate.screenY + candidate.radiusPx + GAP_PX;

  if (anchor === 'top') {
    top = candidate.screenY - candidate.radiusPx - GAP_PX - HEIGHT_PX;
  } else if (anchor === 'right') {
    left = candidate.screenX + candidate.radiusPx + GAP_PX;
    top = candidate.screenY - halfHeight;
  } else if (anchor === 'left') {
    left = candidate.screenX - candidate.radiusPx - GAP_PX - boxWidth;
    top = candidate.screenY - halfHeight;
  }

  return { left, top, right: left + boxWidth, bottom: top + HEIGHT_PX };
}

function rectsIntersect(a: GraphLabelRect, b: GraphLabelRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * 矩形与圆是否相交。
 *
 * 先把圆心**钳进**矩形，再量钳位点到圆心的距离 —— 这是矩形到圆心距离的标准算法。
 * 写成「圆心到四条边的最小距离」会漏掉「圆心落在矩形内部」那一支，而那一支恰恰是
 * 「标签正盖在点上」这个最该拦住的情况。
 */
function rectIntersectsCircle(
  rect: GraphLabelRect,
  centerX: number,
  centerY: number,
  radius: number
): boolean {
  const nearestX = Math.max(rect.left, Math.min(centerX, rect.right));
  const nearestY = Math.max(rect.top, Math.min(centerY, rect.bottom));
  return Math.hypot(centerX - nearestX, centerY - nearestY) < radius;
}

/** 超宽就截断成 `…`；`…` 本身都放不下时返回空串（调用方据此丢弃这个标签）。 */
export function clampToWidth(
  text: string,
  maxWidthPx: number,
  measureTextWidth: (text: string) => number
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || maxWidthPx <= 0) return '';
  if (measureTextWidth(trimmed) <= maxWidthPx) return trimmed;

  if (measureTextWidth(ELLIPSIS) > maxWidthPx) return '';

  // 从后往前逐字砍：文件名 / 标题的区分度在前部，砍尾比砍头有信息量。
  // 二分不适用 —— 字符不等宽，「截断长度 → 宽度」只是单调不减，不是线性。
  for (let length = trimmed.length - 1; length > 0; length -= 1) {
    const candidate = trimmed.slice(0, length) + ELLIPSIS;
    if (measureTextWidth(candidate) <= maxWidthPx) return candidate;
  }
  return '';
}
