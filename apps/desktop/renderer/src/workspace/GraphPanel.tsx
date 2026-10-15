import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentType, GraphDocumentNode, GraphNode, WorkspaceGraph } from '@nexus/core';
import { useLocale, useSetting, useTheme } from '../hooks.js';
import {
  GRAPH_MODES,
  GRAPH_SCOPE_DEGREES,
  type GraphMode
} from '../settings/preference-specs.js';
import {
  CLUSTER_TOKENS,
  LEGEND_MAX_ROWS,
  UNCLUSTERED_TOKEN,
  assignClusterSlots,
  clusterOf,
  rankClusters
} from './graph-clusters.js';
import { birthHaloAlpha, birthHaloRadius, birthRadiusFactor } from './graph-birth.js';
import { DeadLinksList, HubsList, OrphansList } from './GraphLists.js';
import { requireGraphBridge, type GraphPhase } from './graph-load.js';
import { iterationsForNodeCount, layoutGraph } from './graph-layout.js';
import {
  labelBudget,
  planGraphLabels,
  type GraphLabelCandidate,
  type GraphLabelPlacement
} from './graph-labels.js';
import {
  IDENTITY_VIEW,
  fitView,
  panBy,
  projectPoint,
  unprojectPoint,
  zoomAt,
  type GraphView
} from './graph-view.js';

export interface GraphPanelProps {
  /**
   * 图谱落在哪一区。
   *
   * - `sidebar`：老位置，活动栏的窄面板（默认）。
   * - `main`：主区（编辑区的位置，2026-10-14 起默认由「图谱」图标切进去）。
   *
   * 只改外观（标题字号、控件排布），画布与交互完全同一套：`.nexus-graph-body`
   * 是 `flex: 1`，给多大盒子就撑多大；尺寸变化由 ResizeObserver 接住，
   * 布局有 150ms 防抖。所以宽区不需要第二份实现。
   */
  variant?: 'sidebar' | 'main';
  /** 当前活动文档的绝对路径，用于高亮它的节点 */
  activeFilePath: string | null;
  /**
   * 打开一篇文档。
   *
   * `anchor` 是节点上的**代表性锚点**（`[[dma#性能]]` 里的 `性能`），传下去之后
   * 打开会落在那一节而不是文档开头。不传 / 传 `undefined` = 落到开头 ——
   * 一篇没有任何带锚点引用的文档就是这种情形。
   */
  onOpenFile: (filePath: string, anchor?: string) => void;
  /**
   * 点击**断链节点**时调用，参数是归一化后的链接目标（如 `notes/dma`）。
   *
   * 与 `onOpenFile` 分开是有意的：断链没有文件可打开，它对应的动作是**新建**。
   * 合成到一个回调里、靠「路径存不存在」分流的话，图谱这一层就要去查磁盘了。
   */
  onCreateMissingLink: (linkTarget: string) => void;
  /**
   * 图谱**真·空态**（整个工作区一篇文档都没有）里的两个动作。
   *
   * 必须由宿主传进来，不能面板自己实现：
   * - 新建文档要走 `new-file` 命令的**同一个**处理函数（Ctrl+N / 菜单 / 标签栏 `+` 都是它）——
   *   在这里另写一份，就会出现「从这个入口新建的文档不进索引」这类同源问题；
   * - 打开搜索要展开活动栏的搜索那一屏，那是宿主的布局状态。
   */
  onCreateDocument: () => void;
  onOpenSearch: () => void;
  /** 索引变化信号；变化时重读图 */
  revision: number;
}

/** 节点基础半径；实际半径再按 degree 增长（封顶，免得枢纽节点大到盖住别的）。 */
const NODE_RADIUS = 3;
const MAX_DEGREE_BONUS = 6;
/** 点击命中额外放宽的像素，手指不好精确点到 3px 的圆。 */
const HIT_SLACK = 4;
/**
 * 选中环相对节点半径的外扩量。
 *
 * 比活跃 / 悬停那两个环（都是 `+3`）**更大**：三个环可能同时出现（选中的恰好是活跃文档，
 * 或者鼠标正停在它上面），同一半径上叠两圈就分不出那是两件事。
 */
const SELECTED_RING_OFFSET = 6;

/** 标签字号。必须与 `graph-labels.ts` 里的 `FONT_SIZE_PX` 一致 —— 那边按它算盒高。 */
const LABEL_FONT_SIZE_PX = 10;

/** 连线短于这个长度就不画箭头 —— 密集处它们会叠成一坨黑点，比没有更看不出方向。 */
const MIN_ARROW_LINE_PX = 14;

/** 滚轮一格大约 100，乘这个系数后每格约 1.1 倍 —— 再快就调不准。 */
const WHEEL_ZOOM_SENSITIVITY = 0.001;
/** 双击 / 生长后自动取景时四周留的空隙。 */
const FIT_PADDING_PX = 28;
/** 鼠标移动不超过这个距离才算「点击」，否则算拖拽 —— 否则拖完节点会顺手打开文档。 */
const CLICK_SLOP_PX = 4;
/** 悬停时非邻域节点的不透明度。太低会看不清「图还在那儿」。 */
const DIM_ALPHA = 0.25;

/**
 * 画布尺寸变化后等多久才重算布局。
 *
 * 拖侧栏时 `ResizeObserver` **每个像素都报一次**，而一次布局是 300 次迭代的 O(n²) ——
 * 不防抖的话拖动全程都在重算（100 篇实测 8ms/次、400 篇 136ms/次，后者直接卡成幻灯片）。
 * 等尺寸停下来再算：拖动过程中图保持旧形状，松手后 150ms 内收敛。
 *
 * 150ms 是「看不出停顿」与「不白算」之间的取：再短会在一帧内算好几遍，
 * 再长用户会觉得松手之后图愣一下。
 */
const LAYOUT_SETTLE_MS = 150;


/*
  三个视图、两种范围、被关掉的类型 —— 这三项都是**视图状态**（跨会话成立的阅读习惯），
  落盘但不进 `FIELDS`。理由与值域见 `preference-specs.ts`。
*/;

/** 节点的屏幕半径：基础值 + degree 加成。绘制、命中、标签避让三处必须用同一个值。 */
function nodeRadius(node: { degree: number }): number {
  return NODE_RADIUS + Math.min(node.degree, MAX_DEGREE_BONUS);
}

/**
 * 这个节点是不是当前活动的那篇文档。
 *
 * ## 比的是**绝对路径**，不是相对路径
 *
 * `activeFilePath` 是 App 传下来的绝对路径，而 `relativePath` 是工作区相对的 ——
 * 拿后者去比**永远不相等**。这个 bug 从图谱第一次落地起就在：活跃文档从来没被高亮过，
 * 而没有任何用例守着它（画布上的颜色从外面看不见）。
 *
 * 两侧都先把反斜杠归一成正斜杠：主进程给的是平台原生分隔符，App 那边可能是另一种写法。
 */
function isActiveGraphNode(node: GraphNode, normalizedActivePath: string | undefined): boolean {
  return (
    node.kind === 'document' &&
    normalizedActivePath !== undefined &&
    node.path.replace(/\\/g, '/') === normalizedActivePath
  );
}

/**
 * 按**绝对路径**找文档节点。
 *
 * 断链节点没有 `path` 字段，所以这里不能写成 `node.path === filePath` ——
 * 联合类型里另一半没有这个字段。写成类型谓词之后返回的就是文档节点，调用方直接拿 `anchor`。
 *
 * 不做路径归一化：两边都来自主进程的同一列，写法天然一致
 * （`isActiveGraphNode` 要归一化是因为 `activeFilePath` 来自另一个来源）。
 */
function findDocumentNode(
  nodes: readonly GraphNode[],
  filePath: string
): GraphDocumentNode | undefined {
  return nodes.find(
    (node): node is GraphDocumentNode => node.kind === 'document' && node.path === filePath
  );
}

/**
 * 出生动画：单个节点/边淡入的时长，以及相邻条目的错峰间隔。
 *
 * `MAX_BIRTH_STEPS` 是错峰的上限 —— 100 个节点逐个错开 45ms 的话，最后一个要等
 * 4.5 秒才出现，那就不是动画而是加载了。封顶之后整批最迟 540ms 全部到位。
 */
const BIRTH_MS = 420;
const BIRTH_STAGGER_MS = 45;
const MAX_BIRTH_STEPS = 12;

/** 节点淡入到这个程度才画名字。名字先于圆点出现会看着像闪了一下。 */
const LABEL_MIN_BIRTH = 0.65;

/** 聚焦当前文档时的平移时长。 */
const FOCUS_MS = 320;

/**
 * 聚焦的判据：当前文档**已经在视口里**（四周留这么多比例的边距）就不动。
 *
 * 用「在不在视口里」而不是「离中心够不够近」：后者的阈值只能拍，而且含义会随画布尺寸
 * 漂 —— 画布一大，「够近」就变成了「离得很远」，于是每换一篇文档都平移一下。
 *
 * 这是「把某项带进视野」的通用判据，与大纲「已经在视野里就一动不动」是同一条。
 */
const FOCUS_VIEWPORT_MARGIN = 0.12;

/**
 * 系统是否要求减少动态效果。
 *
 * 图谱的动画（出生淡入、聚焦平移）都是**纯装饰** —— 关掉它一个信息都不少。
 * 而前庭功能障碍的用户会被这类平移动画影响，所以这条判据不是可选项。
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 出生进度按「节点 id / 边的两端」记账，与图数据的身份一致。 */
function nodeBirthKey(id: number): string {
  return `n:${id}`;
}

function edgeBirthKey(edge: { source: number; target: number }): string {
  return `e:${edge.source}:${edge.target}`;
}

/**
 * 箭头大小随缩放走，但夹在 3–8 屏幕像素之间。
 *
 * 不夹的话：缩到 0.3 倍时箭头只有 2px，看不出是个箭头；放到 4 倍时箭头比节点还大，
 * 图会变成一堆三角。
 */
function clampArrowSize(scale: number): number {
  return Math.min(8, Math.max(3, 6 * scale));
}

/**
 * 在 `to` 那一端画一个箭头，尖端落在 `to` 节点**边缘**（`edgeRadius` 之外 1px）。
 *
 * ## 两个必须的判据
 *
 * 1. **线太短就不画。** 节点密集时相邻两点的连线只有几像素，箭头会叠成一坨黑点 ——
 *    那比没有箭头更看不出方向。
 * 2. **从节点边缘收住**，不是从圆心。画在圆心的话，后画的节点圆会把它盖掉，
 *    表现成「箭头不见了」，而代码看起来完全正常。
 */
function drawArrowhead(
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  edgeRadius: number,
  size: number
): void {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  if (length < MIN_ARROW_LINE_PX) return;

  const unitX = deltaX / length;
  const unitY = deltaY / length;
  const tipX = to.x - unitX * (edgeRadius + 1);
  const tipY = to.y - unitY * (edgeRadius + 1);

  const baseX = tipX - unitX * size;
  const baseY = tipY - unitY * size;
  const half = size * 0.42;

  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(baseX + -unitY * half, baseY + unitX * half);
  context.lineTo(baseX - -unitY * half, baseY - unitX * half);
  context.closePath();
  context.fill();
}

/**
 * 从 CSS 变量读颜色。Canvas 不认变量，只能读出来再传给绘制调用 —— 写死颜色的话，
 * 浅色主题下图谱会是一片看不清的灰点。
 *
 * 不给兜底色：兜底值会变成第三套配色，主题失效时静默退回它，比画不出来更难发现。
 */
function readColor(element: HTMLElement, name: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  if (!value) console.error(`[graph] CSS 变量 ${name} 未定义，图谱颜色不正确`);
  return value;
}

interface DragState {
  kind: 'pan' | 'node';
  /** `kind === 'node'` 时有值 */
  nodeId: number | null;
  /** 按下时的屏幕坐标 */
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** 是否已经超过点击容差。决定松手时是「打开文档」还是「拖完了」 */
  moved: boolean;
}

/** 图谱面板：把工作区的链接关系画成一张图。 */
export const GraphPanel: React.FC<GraphPanelProps> = ({
  activeFilePath,
  onOpenFile,
  onCreateMissingLink,
  onCreateDocument,
  onOpenSearch,
  revision,
  variant = 'sidebar'
}) => {
  const { t } = useLocale();
  /*
    主题进依赖是为了**重画**：画布的颜色是 `readColor()` 读出来的，读一次就定死在
    位图里 —— 换主题时 CSS 变量变了，但没人叫醒绘制 effect，图谱会停在旧配色上。
    其它组件用 CSS 变量写样式，天然跟着变，只有 canvas 这一处需要显式订阅。
  */
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<WorkspaceGraph>({ nodes: [], edges: [] });
  /**
   * 工作区里**出现过**的文档类型及各类型篇数。
   *
   * 单独取一次全量图是为了它：类型筛选一旦生效，`graph` 里就看不到被筛掉的类型了，
   * 用它渲染筛选条的话，用户一关掉某个类型、那个类型的开关就消失了 —— 再也打不开。
   */
  const [typeCounts, setTypeCounts] = useState<Array<{ type: DocumentType; count: number }>>([]);
  const [mode, setMode] = useSetting('graph.mode');
  const [scope, setScope] = useSetting('graph.scope');
  /** 被**关掉**的类型（而不是「打开的类型」）：默认空 = 全部显示，与旧行为一致。 */
  const [hiddenTypes, setHiddenTypes] = useSetting('graph.hiddenTypes');
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** 标签放置结果。绘制时算出来，只为**暴露给测试**而存进 state —— canvas 上的文字从外面看不见。 */
  const [labelPlacements, setLabelPlacements] = useState<GraphLabelPlacement[]>([]);
  /** 图例行。颜色要在绘制时从 CSS 变量读，所以由绘制 effect 算好交给渲染。 */
  const [legend, setLegend] = useState<Array<{ label: string; color: string; count: number }>>([]);
  const [view, setView] = useState<GraphView>(IDENTITY_VIEW);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  /** 被拖动过的节点位置（**图坐标**）。只是视图副本：布局一重排就丢弃，见下面的 effect。 */
  const [pinned, setPinned] = useState<ReadonlyMap<number, { x: number; y: number }>>(new Map());
  const [panning, setPanning] = useState(false);
  /*
    取数的四态。两路查询各有自己的 phase（类型清单是次要控件，它挂了不该连累画布），
    但**顺序与语义只有一条**（见 graph-load.ts）。
  */
  const [graphPhase, setGraphPhase] = useState<GraphPhase>('loading');
  const [typesPhase, setTypesPhase] = useState<GraphPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  /*
    被**选中**的节点 id。与「活跃文档」是两件事：活跃是「编辑器里开着的那篇」，
    选中是「我此刻在图谱上看着的那一个」。两者可以同时成立 —— 选中另一篇时，
    活跃那篇的环不能消失（参考里那个状态叫 `active-selected`）。

    **不落盘**：它回答的是「我正看着哪儿」，重启之后没有意义；而且 id 是索引分配的，
    落盘之后在新工作区里会指向另一个节点 —— 那比没有更糟。
  */
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);

  const dragRef = useRef<DragState | null>(null);
  /**
   * 每个节点/边的出生时刻。用 ref 而不是 state：它只被绘制路径读，进 state 会让
   * 每帧都触发一次 React 重渲染，而动画本来就该在画布上完成。
   */
  const bornAtRef = useRef(new Map<string, number>());
  /**
   * 事件处理器要读**当前**的视图（把屏幕坐标反投影成图坐标）。
   *
   * 用 ref 而不是把 `view` 放进依赖：放进依赖的话每次缩放/平移都要重建一堆 handler，
   * 而 `wheel` 是原生监听、重建意味着反复摘挂。事件里读 ref 是这里唯一需要「最新值」的场景。
   */
  const viewRef = useRef(view);
  viewRef.current = view;

  /** 当前生效的类型白名单；全都没关掉时是 `undefined`（= 不筛）。 */
  const visibleTypes = useMemo(
    () => typeCounts.map((entry) => entry.type).filter((type) => !hiddenTypes.includes(type)),
    [typeCounts, hiddenTypes]
  );
  const hasTypeFilter = hiddenTypes.length > 0 && typeCounts.length > 0;

  /*
    查询对象**记忆化**之后再进 effect 依赖。

    直接依赖 `visibleTypes` 会在每次渲染时换一个新数组、effect 每轮都跑；
    而写 `visibleTypes.join(',')` 这种表达式又绕过了依赖检查。记忆化对象两头都满足。

    `centerPath` **在两种范围下都传**，裁多大交给 `degrees` 决定。这样主进程每次都
    校验一次「这个焦点还在不在筛过的图里」，`centerMissing` 于是**与范围无关** ——
    换成「只在 current 时传」，退回全图的那一刻判定就没了，按钮会在可用/不可用之间来回跳。
  */
  const query = useMemo(
    () => ({
      centerPath: activeFilePath ?? undefined,
      degrees: scope === 'current' ? GRAPH_SCOPE_DEGREES : undefined,
      types: hasTypeFilter ? visibleTypes : undefined
    }),
    [scope, activeFilePath, hasTypeFilter, visibleTypes]
  );

  // 筛选条上的类型清单只在索引变化时重取 —— 与范围/筛选无关
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const full = await requireGraphBridge().getGraph();
        if (cancelled) return;
        const counts = new Map<DocumentType, number>();
        for (const node of full.nodes) {
          // 断链没有类型 —— 它们不该出现在类型筛选条上（没有「断链」这一类可关）
          if (node.kind !== 'document') continue;
          counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
        }
        setTypeCounts([...counts].map(([type, count]) => ({ type, count })));
        setTypesPhase('ready');
      } catch (err) {
        console.error('Failed to load graph types:', err);
        if (!cancelled) setTypesPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await requireGraphBridge().getGraph(query);
        if (cancelled) return;
        setGraph(result);
        setGraphPhase('ready');
        setLoadError(null);
      } catch (err) {
        console.error('Failed to load graph:', err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setGraphPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision, query]);

  /*
    「当前文档」这个范围**现在能不能用**。只看两件事，与 `scope` 无关：

    1. 有没有活动文档；
    2. 有的话，它还在不在**筛过之后**的图里（`centerMissing`）。

    第 2 条是主进程算的，不是这里猜的：文档还没进索引、或它的类型被用户关掉，
    这两种情况下邻域都算不出来，主进程会如实回报。**不要**改成「在 `graph.nodes`
    里找一遍路径」—— 那要求「全图必须返回每一篇筛过的文档」，是个隐式约定，
    以后图谱加上节点数上限就会静默失效。
  */
  const centerUnavailable = useMemo(() => {
    if (activeFilePath === null) return true;
    /*
      取数还没成功之前不下结论。那时 `graph` 是上一轮的结果，拿它判会让按钮先禁后放；
      加载中/失败态下保持可点，点了也只是重新取一次。
    */
    return graphPhase === 'ready' && graph.centerMissing === true;
  }, [activeFilePath, graphPhase, graph]);

  /*
    当前文档用不了时退回全图。

    不退回的话，`scope` 还是 `'current'` 而查询给不出邻域 —— 主进程会返回全图，
    但按钮上仍然写着「当前文档」。界面说的和画出来的不一致，而用户只会觉得图谱没反应。

    **不会来回跳**：判定（`centerUnavailable`）只依赖活动文档与筛选结果，退回全图
    并不会让它变回「可用」—— 这正是 `centerPath` 在两种范围下都要传的原因。
  */
  useEffect(() => {
    if (centerUnavailable && scope === 'current') setScope('all');
  }, [centerUnavailable, scope]);

  /*
    跟随**画布本身**的尺寸，不是整个面板。

    两者差一个头部（`.nexus-sidebar-header`）。量错的话 `size.height` 会比画布高出一截，
    而画布的像素尺寸是按 `size` 设的、CSS 高度却由 flex 决定 —— 结果是位图被纵向压扁，
    图与标签一起走形。判据：`size` 必须等于 `canvas.getBoundingClientRect()`。
  */
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /*
    布局用的是**稳定之后**的尺寸，绘制用的是当前尺寸。

    首次拿到非零尺寸时立即算一次（否则打开面板要空等 150ms）；之后的每次变化都等它停下来。
  */
  const [layoutSize, setLayoutSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    if (layoutSize.width === 0) {
      setLayoutSize({ width: size.width, height: size.height });
      return;
    }

    const timer = setTimeout(
      () => setLayoutSize({ width: size.width, height: size.height }),
      LAYOUT_SETTLE_MS
    );
    return () => clearTimeout(timer);
  }, [size.width, size.height, layoutSize.width]);

  const layout = useMemo(() => {
    if (layoutSize.width <= 0 || layoutSize.height <= 0) return [];
    return layoutGraph(graph, {
      width: layoutSize.width,
      height: layoutSize.height,
      // 节点一多就把迭代次数压下来，代价与推导见 iterationsForNodeCount
      iterations: iterationsForNodeCount(graph.nodes.length)
    });
  }, [graph, layoutSize.width, layoutSize.height]);

  /*
    布局重排就丢弃拖动结果。

    拖动是**视图层的临时覆盖**，不是新的布局事实：留着它会让「图上的位置」与
    「布局算出来的位置」两套事实长期并存，而重排之后旧坐标可能落在任何地方。
    索引一变（增删文档）就重排，那时用户本来也认不出原来那个形状。
  */
  useEffect(() => {
    setPinned(new Map());
  }, [layout]);

  /** 每个分区有多少篇文档。断链没有目录，不参与。 */
  const clusterCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.kind !== 'document') continue;
      const cluster = clusterOf(node.relativePath);
      if (cluster === null) continue;
      counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
    }
    return counts;
  }, [graph.nodes]);

  const clusterSlots = useMemo(() => assignClusterSlots(clusterCounts), [clusterCounts]);

  /** 当前活动文档在图上的节点 id。只用来**暴露给测试** —— 画布上的描边从外面看不见。 */
  const activeNodeId = useMemo(() => {
    const normalized = activeFilePath?.replace(/\\/g, '/');
    return graph.nodes.find((node) => isActiveGraphNode(node, normalized))?.id ?? null;
  }, [graph.nodes, activeFilePath]);

  /*
    选中的那个节点。**从图里找回来**而不是直接信 `selectedNodeId`：换了筛选 / 范围之后
    那个 id 可能已经不在图上了，这时应当按「没选」处理，而不是让详情条挂着一个
    画不出来的节点。
  */
  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId]
  );

  /**
   * 选中节点的入链 / 出链条数。
   *
   * 口径与 `getGraph` **一致**：数的是 `graph.edges`（已经按「来源文档 → 目标」合并过的边），
   * 不是 `links` 表的行数 —— 同一篇文档里写两次 `[[dma]]` 只算一条边。
   */
  const selectedLinks = useMemo(() => {
    if (selectedNode === null) return { incoming: 0, outgoing: 0 };
    let incoming = 0;
    let outgoing = 0;
    for (const edge of graph.edges) {
      if (edge.target === selectedNode.id) incoming += 1;
      if (edge.source === selectedNode.id) outgoing += 1;
    }
    return { incoming, outgoing };
  }, [graph.edges, selectedNode]);

  /** 选中的**文档**节点 id（断链没有标签可查，按 `null` 处理）。 */
  const selectedDocumentId =
    selectedNode !== null && selectedNode.kind === 'document' ? selectedNode.id : null;

  /**
   * 选中文档的标签。**按需取，不塞进图谱载荷**。
   *
   * 图谱每次切范围 / 切筛选都要重发整张图，把标签挂在每个节点上等于让它们跟着重发一遍，
   * 而画面上一次只显示一个节点的标签。
   */
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  /** 标签读不出来。**必须看得见** —— 见下面的注释。 */
  const [tagsUnavailable, setTagsUnavailable] = useState(false);

  useEffect(() => {
    /*
      先清空再取。不清的话，新选中的那一篇会**顶着上一篇的标签**显示一瞬间 ——
      那是错误数据，比「还没加载好」糟得多。
    */
    setSelectedTags([]);
    setTagsUnavailable(false);

    if (selectedDocumentId === null) return;

    let cancelled = false;

    void (async () => {
      try {
        const tags = await requireGraphBridge().tagsOf(selectedDocumentId);
        if (cancelled) return;
        setSelectedTags(tags);
        setTagsUnavailable(false);
      } catch (err) {
        console.error('Failed to load graph node tags:', err);
        if (cancelled) return;
        /*
          失败**不能**画成「这篇没有标签」—— 那是对用户数据的一个错误结论，
          而用户看不出区别。与类型清单挂掉时同一条规矩（`graph.typesUnavailable`）。
        */
        setSelectedTags([]);
        setTagsUnavailable(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedDocumentId]);

  /*
    切视图 / 索引变化之后清掉选中。

    前者是「这一屏换了」；后者是「节点 id 可能全变了」—— 留着的话详情条会挂在一个
    已经不存在的 id 上，更糟的是指向另一篇文档。点空白清除见 `endDrag`。
  */
  useEffect(() => {
    setSelectedNodeId(null);
  }, [mode, revision]);

  /*
    图例。**列的是「屏幕上真的有颜色」的那些分区** —— 图例与画面对不上比没有图例更糟。
    第 7 个及以后的分区共用中性色，所以合并成一行「其他」；根目录下的文档也在那一行里。

    单独一个 effect（不塞进绘制那条）有两个好处：它不需要 canvas 上下文，因此能在
    renderer 测试里跑；而且图例是 DOM，本来就不该跟着画布的重绘节奏走。
  */
  useEffect(() => {
    /*
      颜色从 `document.documentElement` 读，不从容器读：主题把变量写在 `:root` 上，
      而自定义属性**不参与 happy-dom 的继承解析**（只在定义它的那个元素上取得到）——
      从容器读的话 renderer 测试里永远读回空串，而生产环境两种写法都对。
    */
    const root = document.documentElement;

    const ranked = rankClusters(clusterCounts);
    const rows = ranked.slice(0, LEGEND_MAX_ROWS).map((name) => {
      const slot = clusterSlots.get(name);
      return {
        label: name,
        color:
          slot === undefined || slot === null
            ? readColor(root, UNCLUSTERED_TOKEN)
            : readColor(root, CLUSTER_TOKENS[slot]!),
        count: clusterCounts.get(name) ?? 0
      };
    });

    const foldedCount =
      ranked.slice(LEGEND_MAX_ROWS).reduce((sum, name) => sum + (clusterCounts.get(name) ?? 0), 0) +
      graph.nodes.filter(
        (node) => node.kind === 'document' && clusterOf(node.relativePath) === null
      ).length;
    if (foldedCount > 0) {
      rows.push({
        label: t('graph.legend.other'),
        color: readColor(root, UNCLUSTERED_TOKEN),
        count: foldedCount
      });
    }

    setLegend(rows);
  }, [clusterCounts, clusterSlots, graph.nodes, t, resolvedTheme?.id]);

  /** 有效位置：拖动过的用拖动值，其余用布局值。 */
  const positionById = useMemo(() => {
    const positions = new Map<number, { x: number; y: number }>();
    for (const node of layout) positions.set(node.id, pinned.get(node.id) ?? { x: node.x, y: node.y });
    return positions;
  }, [layout, pinned]);

  /** 一度邻域。悬停时用来决定「谁亮着」。 */
  const neighborsById = useMemo(() => {
    const neighbors = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      const set = neighbors.get(a) ?? new Set<number>();
      set.add(b);
      neighbors.set(a, set);
    };
    for (const edge of graph.edges) {
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }
    return neighbors;
  }, [graph.edges]);

  /** 屏幕坐标 → 命中的节点 id（取最近的一个）。 */
  const hitTest = useCallback(
    (screenX: number, screenY: number): number | null => {
      const current = viewRef.current;
      let hit: { id: number; distance: number } | null = null;

      for (const node of graph.nodes) {
        const position = positionById.get(node.id);
        if (!position) continue;

        const screen = projectPoint(current, position.x, position.y);
        const distance = Math.hypot(screen.x - screenX, screen.y - screenY);
        const radius = nodeRadius(node) * current.scale + HIT_SLACK;
        if (distance <= radius && (hit === null || distance < hit.distance)) {
          hit = { id: node.id, distance };
        }
      }

      return hit?.id ?? null;
    },
    [graph.nodes, positionById]
  );

  /*
    滚轮缩放要**原生**监听并 `preventDefault`：React 的 `onWheel` 挂在根容器上且是 passive 的，
    在里面调 `preventDefault` 不生效 —— 表现是「缩放的同时侧栏跟着滚」，两个动作一起发生。
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      setView((prev) =>
        zoomAt(prev, factor, event.clientX - rect.left, event.clientY - rect.top)
      );
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [graph.nodes.length]);

  const screenPointOf = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const point = screenPointOf(event);
      const nodeId = hitTest(point.x, point.y);

      dragRef.current = {
        kind: nodeId === null ? 'pan' : 'node',
        nodeId,
        startX: point.x,
        startY: point.y,
        lastX: point.x,
        lastY: point.y,
        moved: false
      };
      setPanning(nodeId === null);
    },
    [hitTest]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const point = screenPointOf(event);
      const drag = dragRef.current;

      if (drag === null) {
        setHoveredId(hitTest(point.x, point.y));
        return;
      }

      const deltaX = point.x - drag.lastX;
      const deltaY = point.y - drag.lastY;
      drag.lastX = point.x;
      drag.lastY = point.y;
      if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > CLICK_SLOP_PX) {
        drag.moved = true;
      }

      if (drag.kind === 'pan') {
        setView((prev) => panBy(prev, deltaX, deltaY));
        return;
      }

      if (drag.nodeId !== null) {
        const target = unprojectPoint(viewRef.current, point.x, point.y);
        setPinned((prev) => new Map(prev).set(drag.nodeId!, target));
      }
    },
    [hitTest]
  );

  /**
   * 一次按-放结束。**单击 = 选中，不打开。**
   *
   * 打开文档会让图谱退场（主区要显示那篇文档），所以「点一下就离开图谱」等于
   * 「没法在图谱上先看清一个点连着谁，再决定要不要打开」。打开改由**双击**承担
   * （见 `handleDoubleClick`）—— 那是老用户的肌肉记忆，不能只留详情条上的按钮。
   */
  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (drag === null) return;

    // 拖过了就不算点击 —— 否则拖完一个节点会顺手把它选中，把用户刚摆好的视角又改一次
    if (drag.moved) return;

    if (drag.kind === 'pan') {
      // 点空白 = 取消选中
      setSelectedNodeId(null);
      return;
    }

    if (drag.nodeId === null) return;
    // 再点一次已选中的节点 = 取消选中。用函数式更新，免得把 `selectedNodeId` 拉进依赖。
    setSelectedNodeId((prev) => (prev === drag.nodeId ? null : drag.nodeId));
  }, []);

  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
    setPanning(false);
    setHoveredId(null);
  }, []);

  /**
   * 打开一篇文档，落在它的**代表性锚点**上。
   *
   * 画布上的节点直接带着 `anchor`；三张清单（孤儿 / 枢纽 / 断链）只拿到路径 ——
   * 它们的数据来自另一条查询，节点上没挂锚点。所以按路径回图里找一次：
   * **同一个动作从哪一行发起都该落到同一节**，否则「从清单点开」和「从画布点开」
   * 落在文档的两个位置，用户只会觉得其中一个坏了。
   *
   * 清单里可能有当前图载荷之外的文档（它自己带筛选条件），那时找不到，退回打开到开头。
   */
  const openDocumentAtAnchor = useCallback(
    (filePath: string, anchor?: string) => {
      const resolved = anchor ?? findDocumentNode(graph.nodes, filePath)?.anchor;
      // 没有锚点时**不传第二个参数**：调用方那边 `undefined` 与「不传」是同一件事，
      // 但少传一个参数让「这次没有锚点」在调用记录里一眼看得见。
      if (resolved === undefined) onOpenFile(filePath);
      else onOpenFile(filePath, resolved);
    },
    [graph.nodes, onOpenFile]
  );

  /**
   * 双击：**节点上**是「打开 / 新建」，空白处是「取景」。
   *
   * 打开必须留一个双击入口 —— 单击改成选中之后，只给详情条上的按钮的话，老用户会觉得
   * 「点不动了」（他们的肌肉记忆就是单击打开）。断链没有文件可打开，它走的是
   * 「按这个目标名新建一篇」。
   */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const point = screenPointOf(event);
      const nodeId = hitTest(point.x, point.y);

      if (nodeId !== null) {
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        if (node === undefined) return;
        if (node.kind === 'missing') onCreateMissingLink(node.linkTarget);
        else openDocumentAtAnchor(node.path, node.anchor);
        return;
      }

      setView(
        fitView(
          [...positionById.values()],
          { width: size.width, height: size.height },
          FIT_PADDING_PX
        )
      );
    },
    [hitTest, graph.nodes, openDocumentAtAnchor, onCreateMissingLink, positionById, size.width, size.height]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);

    const context = canvas.getContext('2d');
    if (!context) return;

    // 按设备像素比缩放，否则高分屏上线条发虚
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    /*
      出生动画的记账。

      `bornAt` 存的是**绝对时间戳**，所以每帧算进度都不需要额外状态，也不必在 effect
      之间传递「动画进行到哪了」。图里消失的条目要清掉，否则反复增删文档会让这张表
      无限长大。
    */
    const reducedMotion = prefersReducedMotion();
    const births = bornAtRef.current;
    const liveKeys = new Set<string>();
    for (const node of graph.nodes) liveKeys.add(nodeBirthKey(node.id));
    for (const edge of graph.edges) liveKeys.add(edgeBirthKey(edge));
    for (const key of [...births.keys()]) {
      if (!liveKeys.has(key)) births.delete(key);
    }

    const appeared = [...liveKeys].filter((key) => !births.has(key));
    appeared.forEach((key, index) => {
      // 错峰有上限：100 个节点逐个错开的话最后一个要等 4.5 秒才出现
      const step = Math.min(index, MAX_BIRTH_STEPS);
      births.set(key, reducedMotion ? 0 : Date.now() + step * BIRTH_STAGGER_MS);
    });

    /** 0 = 刚出现，1 = 完全就位。关掉动画时恒为 1。 */
    const birthProgressOf = (key: string): number => {
      if (reducedMotion) return 1;
      const born = births.get(key);
      if (born === undefined) return 1;

      const raw = (Date.now() - born) / BIRTH_MS;
      if (raw <= 0) return 0;
      if (raw >= 1) return 1;
      // ease-out：开头快、收尾慢，比线性更像「浮现」
      const remaining = 1 - raw;
      return 1 - remaining * remaining * remaining;
    };

    // 节点高亮是图形元素，走图形类阈值（3:1）的 accent-indicator，不是文字类的 accent-text
    const edgeColor = readColor(canvas, '--nexus-border-default');
    const activeColor = readColor(canvas, '--nexus-accent-indicator');
    // 活跃文档改用**描边**区分：填充已经被分区色占了，两个都用填充就分不出谁是谁
    const activeRingColor = readColor(canvas, '--nexus-text-primary');
    // 选中环走 accent 的**文字档**（4.5:1）：它与活跃环可能同时出现，两个都用 text-primary
    // 就变成同一圈；半径不同 + 色相不同，两层才读得出是两件事
    const selectedRingColor = readColor(canvas, '--nexus-accent-text');
    // 断链走警告色：它不是「另一类文档」，是「这里缺了东西」
    const missingColor = readColor(canvas, '--nexus-status-warning-text');

    // 分区着色。调色板借的是主题的 `syntax-*` token（理由见 graph-clusters.ts），
    // 所以这里**不需要判断明暗** —— 读到的已经是当前主题的值。
    const paletteColors = CLUSTER_TOKENS.map((token) => readColor(canvas, token));
    const unclusteredColor = readColor(canvas, UNCLUSTERED_TOKEN);

    const colorForNode = (node: GraphNode): string => {
      if (node.kind !== 'document') return missingColor;
      const cluster = clusterOf(node.relativePath);
      if (cluster === null) return unclusteredColor;
      const slot = clusterSlots.get(cluster);
      return slot === undefined || slot === null ? unclusteredColor : paletteColors[slot]!;
    };

    const normalizedActive = activeFilePath?.replace(/\\/g, '/');
    const isActiveNode = (node: GraphNode) => isActiveGraphNode(node, normalizedActive);

    const toScreen = (id: number) => {
      const position = positionById.get(id);
      return position ? projectPoint(view, position.x, position.y) : null;
    };

    // 悬停时「谁亮着」：被悬停的那个 + 它的一度邻域
    const litIds =
      hoveredId === null
        ? null
        : new Set<number>([hoveredId, ...(neighborsById.get(hoveredId) ?? [])]);

    /** 每个节点在屏幕上的半径。箭头要从节点边缘收住，不能画到圆心（会被圆盖掉）。 */
    const radiusById = new Map<number, number>();
    for (const node of graph.nodes) radiusById.set(node.id, nodeRadius(node) * view.scale);

    /*
      标签**每帧只规划一次**，不在 `draw()` 里 —— 它要量文字宽度，而规划结果每帧都一样。
      放进去的话每帧都要 `setLabelPlacements`，那会变成每秒 60 次 React 重渲染。
    */
    const labelColor = readColor(canvas, '--nexus-text-secondary');
    const activeLabelColor = readColor(canvas, '--nexus-text-primary');
    /*
      chip 底与描边。

      底色用**画布自己的底色**（`--nexus-bg-canvas`）：chip 要的就是「把画布那一块
      重新铺在图上」，这样它压在边和节点上时把下面盖掉、落在空白处时又看不出来。
      配一条 `--nexus-border-subtle` 的 1px 描边，它才读得出是个「片」而不是糊了一块。

      **不新增图谱专用 token**：一对新 token 要动 `derive.ts` 的派生链、对比度审计
      与全部预设，代价远大于收益；而这两个的语义恰好就是这里要的
      （文字色本来就是**按画布底**定出来的，所以「文字压在 chip 上」的可读性
      是构造上成立的，不是碰巧）。
    */
    const labelChipColor = readColor(canvas, '--nexus-bg-canvas');
    const labelChipBorderColor = readColor(canvas, '--nexus-border-subtle');
    const fontFamily = getComputedStyle(canvas).fontFamily || 'sans-serif';
    context.font = `${LABEL_FONT_SIZE_PX}px ${fontFamily}`;
    // `planGraphLabels` 的 `textX` / `textY` 是矩形**左上角**加 padding 算出来的，
    // 所以基线必须是 `top`（默认的 `alphabetic` 会让文字整体浮在 chip 上沿之外）
    context.textBaseline = 'top';

    const candidates: GraphLabelCandidate[] = graph.nodes.flatMap((node) => {
      const screen = toScreen(node.id);
      if (!screen) return [];
      return [
        {
          id: node.id,
          screenX: screen.x,
          screenY: screen.y,
          radiusPx: nodeRadius(node) * view.scale,
          text: node.name,
          isActive: isActiveNode(node),
          degree: node.degree
        }
      ];
    });

    const placements = planGraphLabels({
      candidates,
      viewport: { width: size.width, height: size.height },
      maxLabels: labelBudget(size.width * size.height, view.scale),
      maxLabelWidthPx: Math.max(60, size.width * 0.4),
      measureTextWidth: (text) => context.measureText(text).width
    });

    const arrowSize = clampArrowSize(view.scale);
    const hovered = hoveredId === null ? null : graph.nodes.find((node) => node.id === hoveredId);

    /** 画一帧。出生动画期间由 rAF 反复调用，静止时只调一次。 */
    const draw = () => {
      context.clearRect(0, 0, size.width, size.height);

      context.strokeStyle = edgeColor;
      context.lineWidth = 1;
      context.beginPath();
      for (const edge of graph.edges) {
        const source = toScreen(edge.source);
        const target = toScreen(edge.target);
        if (!source || !target) continue;
        context.globalAlpha =
          litIds !== null && !(litIds.has(edge.source) && litIds.has(edge.target))
            ? DIM_ALPHA
            : 1;
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
      }
      context.stroke();
      context.globalAlpha = 1;

      /*
        箭头单独走一遍，画在**节点之前** —— 节点是后画的，箭头留在圆心就会被圆盖住。
        所以尖端要沿连线退到目标节点的边缘外一点点。
      */
      context.fillStyle = edgeColor;
      for (const edge of graph.edges) {
        const source = toScreen(edge.source);
        const target = toScreen(edge.target);
        if (!source || !target) continue;

        const dimmed = litIds !== null && !(litIds.has(edge.source) && litIds.has(edge.target));
        // 出生的边也从很淡开始，否则新链接会「啪」地跳出来
        const birth = 0.25 + 0.75 * birthProgressOf(edgeBirthKey(edge));
        context.globalAlpha = (dimmed ? DIM_ALPHA : 1) * birth;
        drawArrowhead(context, source, target, radiusById.get(edge.target) ?? 0, arrowSize);
        // 互相引用画双箭头：一条线就说清了「两边都写了」，不必拆成两条重合的线
        if (edge.mutual) {
          drawArrowhead(context, target, source, radiusById.get(edge.source) ?? 0, arrowSize);
        }
      }
      context.globalAlpha = 1;

      for (const node of graph.nodes) {
        const screen = toScreen(node.id);
        if (!screen) continue;

        const birth = birthProgressOf(nodeBirthKey(node.id));
        // 半径跟着出生进度长起来：从「一个小点」扩到正常大小
        const baseRadius = nodeRadius(node) * view.scale;
        const radius = baseRadius * birthRadiusFactor(birth);
        const dimmed = litIds !== null && !litIds.has(node.id);

        if (node.kind === 'missing') {
          /*
            断链画成**空心 + 虚线环**，不是实心点。
            只靠颜色区分不行：色觉障碍用户读不出「这个点还没建」，而虚线轮廓与填充是
            形状差异，任何配色下都成立。
          */
          context.globalAlpha = (dimmed ? DIM_ALPHA : 1) * birth;
          context.beginPath();
          context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          context.strokeStyle = missingColor;
          context.lineWidth = 1.5;
          context.setLineDash([3, 2]);
          context.stroke();
          context.setLineDash([]);
        } else {
          const fillColor = colorForNode(node);

          /*
            出生光晕画在实体**之前**、颜色与实体相同 —— 它要表达的是「这里刚出现了一个点」，
            不是「这里还有一个别的点」。半径与不透明度都随出生进度收敛，到 1 就不画了
            （`birthHaloRadius` 返回 `null`）：静止的图不该留着一圈常驻的外环。

            断链节点不画光晕：它没有填充，也就没有可回声的颜色。
          */
          const halo = birthHaloRadius(baseRadius, birth);
          if (halo !== null) {
            context.globalAlpha = (dimmed ? DIM_ALPHA : 1) * birthHaloAlpha(birth);
            context.beginPath();
            context.arc(screen.x, screen.y, halo, 0, Math.PI * 2);
            context.fillStyle = fillColor;
            context.fill();
          }

          context.globalAlpha = (dimmed ? DIM_ALPHA : 1) * birth;
          context.beginPath();
          context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          context.fillStyle = fillColor;
          context.fill();
        }

        // 活跃文档：填充表示分区，所以它改用描边 —— 密处一眼能认出来
        if (node.kind === 'document' && isActiveNode(node)) {
          context.strokeStyle = activeRingColor;
          context.lineWidth = 2;
          context.beginPath();
          context.arc(screen.x, screen.y, radius + 3, 0, Math.PI * 2);
          context.stroke();
        }

        // 悬停的那个点加一圈描边 —— 只靠不透明度区分，密处看不出是哪一个
        if (node.id === hoveredId) {
          context.strokeStyle = activeColor;
          context.lineWidth = 2;
          context.beginPath();
          context.arc(screen.x, screen.y, radius + 3, 0, Math.PI * 2);
          context.stroke();
        }

        /*
          选中的那个点再外一圈。
          半径比活跃 / 悬停那两个环大（`SELECTED_RING_OFFSET`），所以「选中的正好是活跃文档」
          这个状态两层环都在、且不重叠 —— 那正是参考里 `active-selected` 要表达的东西。
        */
        if (node.id === selectedNodeId) {
          context.strokeStyle = selectedRingColor;
          context.lineWidth = 2;
          context.beginPath();
          context.arc(screen.x, screen.y, radius + SELECTED_RING_OFFSET, 0, Math.PI * 2);
          context.stroke();
        }
      }
      context.globalAlpha = 1;

      /*
        标签画在最后，且**不与节点共用颜色**：节点是图形（3:1 就够），标签是文字（要 4.5:1），
        两者用同一个 token 会让标签在浅色主题下糊在点里。

        节点还没淡入完就先不画名字 —— 否则名字会先于圆点出现，看着像闪了一下。
      */
      for (const placement of placements) {
        if (birthProgressOf(nodeBirthKey(placement.id)) < LABEL_MIN_BIRTH) continue;
        context.globalAlpha = litIds !== null && !litIds.has(placement.id) ? DIM_ALPHA : 1;

        /*
          chip 底 + 1px 描边，**再**画文字。

          这个矩形不是新算的：`placement.rect` 就是避让算法用来判「会不会压到别的标签 /
          别的节点」的那个盒子（文字包围盒 + padding）。以前只用了它的 `textX` / `textY`，
          矩形本身丢掉了 —— 于是标签是裸文字，正好糊在它费力避开的那些东西上。

          描边往里缩 0.5px：`lineWidth = 1` 是骑在路径两侧各半个像素的，不缩的话
          chip 画出来会比 `data-labels` 声明的矩形大一圈。缩进来之后两者严格同框。
        */
        const { rect } = placement;
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        context.fillStyle = labelChipColor;
        context.fillRect(rect.left, rect.top, width, height);
        context.strokeStyle = labelChipBorderColor;
        context.lineWidth = 1;
        context.strokeRect(rect.left + 0.5, rect.top + 0.5, width - 1, height - 1);

        context.fillStyle = placement.isActive ? activeLabelColor : labelColor;
        context.fillText(placement.text, placement.textX, placement.textY);
      }
      context.globalAlpha = 1;

      /*
        悬停信息条。标签只给名字，所以这里补上「名字之外还需要知道的那一点」：
        普通节点是度数，断链是「它指向的文档还没建」—— 后者才是用户此刻的疑问。
      */
      if (hovered) {
        const screen = toScreen(hovered.id);
        if (screen) {
          const text =
            hovered.kind === 'missing'
              ? `${hovered.name} · ${t('graph.missingHint')}`
              : `${hovered.name} · ${hovered.degree}`;
          context.fillStyle = hovered.kind === 'missing' ? missingColor : activeLabelColor;
          context.fillText(text, screen.x + nodeRadius(hovered) * view.scale + 6, screen.y - 6);
        }
      }
    };

    draw();
    setLabelPlacements(placements);

    // 还有条目没淡完就继续出帧。全淡完了就不排帧 —— 静止的图不该占着一帧一次的重绘。
    let frame = 0;
    const stillAnimating = () =>
      [...births.values()].some((born) => Date.now() < born + BIRTH_MS);
    if (!reducedMotion && stillAnimating()) {
      const tick = () => {
        draw();
        if (stillAnimating()) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [
    graph,
    layout,
    positionById,
    neighborsById,
    view,
    size,
    activeFilePath,
    hoveredId,
    selectedNodeId,
    t,
    // 换主题要重画 —— 画布的颜色是读出来定死在位图里的，不订阅就停在旧配色上
    resolvedTheme?.id
  ]);


  /*
    聚焦当前文档：把它平移到视口中心。

    **已经在中间那块里就不动** —— 每换一篇文档图都平移一下很烦，而绝大多数时候那个点
    本来就在视野里。判据与大纲「已经在视野里就一动不动」是同一条。
  */
  const focusedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFilePath === null || prefersReducedMotion()) {
      focusedPathRef.current = activeFilePath;
      return;
    }
    // 同一篇只聚焦一次：拖动节点会改 `positionById`，不挡住的话每次拖动都会触发平移
    if (focusedPathRef.current === activeFilePath) return;

    const normalizedActive = activeFilePath.replace(/\\/g, '/');
    const node = graph.nodes.find((candidate) => isActiveGraphNode(candidate, normalizedActive));
    if (node === undefined) return;

    const position = positionById.get(node.id);
    if (position === undefined || size.width <= 0 || size.height <= 0) return;

    const current = viewRef.current;
    const screen = projectPoint(current, position.x, position.y);
    const deltaX = size.width / 2 - screen.x;
    const deltaY = size.height / 2 - screen.y;

    // 已经在视口里 —— 记下「处理过了」然后什么都不做
    const marginX = size.width * FOCUS_VIEWPORT_MARGIN;
    const marginY = size.height * FOCUS_VIEWPORT_MARGIN;
    const alreadyVisible =
      screen.x >= marginX &&
      screen.x <= size.width - marginX &&
      screen.y >= marginY &&
      screen.y <= size.height - marginY;
    if (alreadyVisible) {
      focusedPathRef.current = activeFilePath;
      return;
    }

    focusedPathRef.current = activeFilePath;

    const startedAt = Date.now();
    let frame = 0;
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / FOCUS_MS);
      const eased = 1 - (1 - progress) * (1 - progress) * (1 - progress);
      setView({
        scale: current.scale,
        offsetX: current.offsetX + deltaX * eased,
        offsetY: current.offsetY + deltaY * eased
      });
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [activeFilePath, graph.nodes, positionById, size.width, size.height]);

  return (
    <div className="nexus-graph" data-variant={variant}>
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.graph')}</span>
        {/*
          「N 个点 / M 条线」是判断这张图密不密的最小信息 —— 只有点数的话，
          二十个点可能是二十条线，也可能一条都没有。

          两个数都必须取**画布上那一份**（`graph` 就是正在画的那张图），不能取全量：
          取错源的话切范围或关类型时只有一个数会动，另一个还停在「整个工作区」，
          于是「4 个点 3 条线」和画面里的东西对不上。
        */}
        {mode === 'explore' && graph.nodes.length > 0 && (
          <span className="nexus-sidebar-header-end">
            <span className="nexus-sidebar-count" data-count="nodes">
              {t('graph.count.nodes', { count: String(graph.nodes.length) })}
            </span>
            <span className="nexus-sidebar-count" data-count="links">
              {t('graph.count.links', { count: String(graph.edges.length) })}
            </span>
          </span>
        )}
      </div>

      {/*
        控制条。两件事：范围（全图 / 当前文档邻域）与类型筛选。
        类型清单来自**未筛选**的那次查询（`typeCounts`），所以关掉一个类型之后
        它的开关还在 —— 否则用户关掉之后就再也打不开了。
      */}
      <div className="nexus-graph-controls">
        <div className="nexus-graph-modes" role="group" aria-label={t('graph.mode')}>
          {GRAPH_MODES.map((value: GraphMode) => (
            <button
              key={value}
              type="button"
              className="nexus-graph-chip"
              data-mode={value}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(`graph.mode.${value}`)}
            </button>
          ))}
        </div>

        {mode === 'explore' && (
          <>
        <div className="nexus-graph-scope" role="group" aria-label={t('graph.scope')}>
          <button
            type="button"
            className="nexus-graph-chip"
            data-scope="all"
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            {t('graph.scopeAll')}
          </button>
          <button
            type="button"
            className="nexus-graph-chip"
            data-scope="current"
            aria-pressed={scope === 'current'}
            disabled={centerUnavailable}
            /*
              两种「用不了」的原因分开说：没有活动文档是常态（用户没打开任何文件），
              而「当前文档不在图里」是另一种情况 —— 用户明明开着文档，需要告诉他
              为什么点不了（还没进索引，或者它的类型被筛掉了）。
            */
            title={
              centerUnavailable
                ? t(
                    activeFilePath === null
                      ? 'graph.scopeCurrentUnavailable'
                      : 'graph.scopeCurrentMissing'
                  )
                : undefined
            }
            onClick={() => setScope('current')}
          >
            {t('graph.scopeCurrent')}
          </button>
        </div>

        {typeCounts.length > 1 && (
          <div className="nexus-graph-types" role="group" aria-label={t('graph.filterTypes')}>
            {typeCounts.map(({ type, count }) => {
              const visible = !hiddenTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  className="nexus-graph-chip"
                  data-type={type}
                  aria-pressed={visible}
                  onClick={() =>
                    setHiddenTypes(
                      hiddenTypes.includes(type)
                        ? hiddenTypes.filter((item) => item !== type)
                        : [...hiddenTypes, type]
                    )
                  }
                >
                  {t(`graph.type.${type}`)}
                  <span className="nexus-graph-chip-count">{count}</span>
                </button>
              );
            })}
          </div>
        )}
        {typesPhase === 'error' && (
          /*
            类型清单是**次要控件**：它挂了不该连累画布（画布照常画）。
            但也不能静默 —— 少了这条，筛选条凭空消失，用户只会觉得「以前有过的开关不见了」。
          */
          <p className="nexus-graph-note">{t('graph.typesUnavailable')}</p>
        )}
          </>
        )}
      </div>

      {/*
        两个清单视图**不进画布那一层**：画布的尺寸由 ResizeObserver 量，
        而清单是普通流式布局，塞进 `.nexus-graph-body` 会把它撑成一个画布盒子。
      */}
      {mode === 'orphans' && (
        <OrphansList revision={revision} onOpenFile={openDocumentAtAnchor} />
      )}
      {mode === 'hubs' && <HubsList revision={revision} onOpenFile={openDocumentAtAnchor} />}
      {mode === 'dead' && <DeadLinksList revision={revision} onOpenFile={openDocumentAtAnchor} />}

      {/*
        这一层是**画布的盒子**：尺寸由它量、绘制坐标也以它为准（见上面 ResizeObserver 的说明）。
        它必须始终存在（空态时也在），否则 `[]` 依赖的观察 effect 首次挂载时拿到 null，
        之后图谱有数据了也不会重新观察。
      */}
      <div
        className="nexus-graph-body"
        ref={containerRef}
        hidden={mode !== 'explore'}
        data-phase={graphPhase}
      >
        {/*
          四态**互斥且顺序固定**：错误 → 加载中 → 空 → 画布。
          错误必须排在空态前面 —— 否则「取数失败」会渲染成「还没有可以画的文档」，
          而用户完全看不出区别（这两句话在屏幕上长得一模一样）。
          `data-phase` 是给测试用的就绪判据：**别用「某个文案出现了」判** ——
          加载态与空态共用同一个类名。
        */}
        {graphPhase === 'error' ? (
          <p className="nexus-graph-note nexus-sidebar-error" data-error={loadError ?? ''}>
            {t('graph.loadFailed')}
          </p>
        ) : graphPhase === 'loading' ? (
          <p className="nexus-sidebar-note">{t('graph.loading')}</p>
        ) : graph.nodes.length === 0 ? (
          /*
            两种「空」必须分开，而且**各自给各自的出路**：

            - **被筛空了** —— 图是有的，只是被开关藏起来了。出路是「显示全部」。
              不给的话用户面对一张空画布，只能靠猜是哪个开关干的。
            - **真·空**（新工作区，一篇文档都没有）—— 这时候「显示全部」是没有用的按钮：
              它显示的还是一个空图。该给的是「怎么让这儿有东西」：新建一篇、或者去搜。

            两档给的按钮**必须不同**。把真·空那档也塞一个「显示全部」，等于给用户一个
            点了什么都不变的按钮 —— 那比没有按钮更让人困惑。
          */
          hasTypeFilter ? (
            <p className="nexus-sidebar-note">
              {t('graph.filteredEmpty')}
              <span className="nexus-graph-empty-actions">
                <button
                  type="button"
                  className="nexus-graph-empty-action"
                  data-action="reset-filters"
                  onClick={() => {
                    setHiddenTypes([]);
                    setScope('all');
                  }}
                >
                  {t('graph.resetFilters')}
                </button>
              </span>
            </p>
          ) : (
            <p className="nexus-sidebar-note">
              {t('graph.empty')}
              <span className="nexus-graph-empty-actions">
                <button
                  type="button"
                  className="nexus-graph-empty-action"
                  data-action="new-document"
                  onClick={onCreateDocument}
                >
                  {t('graph.empty.newDocument')}
                </button>
                <button
                  type="button"
                  className="nexus-graph-empty-action"
                  data-action="open-search"
                  onClick={onOpenSearch}
                >
                  {t('graph.empty.search')}
                </button>
              </span>
            </p>
          )
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="nexus-graph-canvas"
              role="img"
              aria-label={t('graph.title')}
              data-panning={panning ? 'true' : 'false'}
              data-hovered={hoveredId === null ? '' : String(hoveredId)}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={handleMouseLeave}
              onDoubleClick={handleDoubleClick}
            />
            {/*
              选中节点的详情条。**浮层而不是占布局** —— 它是「画布上多出来的一层信息」，
              占布局会把画布高度改掉，于是「选中一个点」就触发一次重排 + 重算布局
              （`ResizeObserver` 那条 150ms 防抖链），点一下卡一下。图例也是浮层，同一套理由。

              `data-selected` 挂在 hitmap 上（画布上的环从外面看不见，判据 21）：
              **判「选没选中」要用它，不要用「详情条出现了」** —— 后者对「详情条画错了」
              同样成立。
            */}
            {selectedNode !== null && (
              <div className="nexus-graph-detail" data-kind={selectedNode.kind}>
                <span className="nexus-graph-detail-name">{selectedNode.name}</span>
                {selectedNode.kind === 'missing' ? (
                  // 断链没有路径、没有类型、也没有标签，能说的只有「它还没建」——详情条不许留空壳
                  <span className="nexus-graph-detail-stat">{t('graph.missingHint')}</span>
                ) : (
                  <>
                    <span className="nexus-graph-detail-path" title={selectedNode.path}>
                      {selectedNode.relativePath}
                    </span>
                    {/*
                      类型名。蓝图 §12 要求「不能只用颜色区分」，而画布上那个圆点里
                      画不下图标 —— 名字放到这里。`data-type` 是给测试的出口：
                      文案随语言变，类型名不变。
                    */}
                    <span className="nexus-graph-detail-stat" data-type={selectedNode.type}>
                      {t(`graph.type.${selectedNode.type}`)}
                    </span>
                    <span className="nexus-graph-detail-stat">
                      {t('graph.detail.links', {
                        incoming: String(selectedLinks.incoming),
                        outgoing: String(selectedLinks.outgoing)
                      })}
                    </span>
                    {selectedTags.length > 0 && (
                      <span className="nexus-graph-detail-tags">
                        {selectedTags.map((tag) => (
                          <span key={tag} className="nexus-graph-detail-tag" data-tag={tag}>
                            #{tag}
                          </span>
                        ))}
                      </span>
                    )}
                    {/*
                      读不出来时说一句，而不是留白 —— 留白与「这篇没有标签」长得一模一样，
                      而用户看不出区别（同一份数据两个结论）。
                    */}
                    {tagsUnavailable && (
                      <span className="nexus-graph-detail-stat">
                        {t('graph.detail.tagsUnavailable')}
                      </span>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="nexus-graph-detail-action"
                  data-action="open"
                  onClick={() =>
                    selectedNode.kind === 'missing'
                      ? onCreateMissingLink(selectedNode.linkTarget)
                      : openDocumentAtAnchor(selectedNode.path, selectedNode.anchor)
                  }
                >
                  {selectedNode.kind === 'missing'
                    ? t('graph.detail.create')
                    : t('graph.detail.open')}
                </button>
                <button
                  type="button"
                  className="nexus-graph-detail-action"
                  data-action="clear"
                  onClick={() => setSelectedNodeId(null)}
                >
                  {t('graph.detail.clear')}
                </button>
              </div>
            )}
            {/*
              画布上的东西从外部没法定位，所以把三样显式暴露出来：
              - `data-nodes`：**布局**坐标，验「布局本身」；
              - `data-screen-nodes`：**投影后**的坐标，验「点击命中」—— 缩放之后必须点得中，
                用布局坐标去点会点空，而那恰恰是投影写反时唯一会露馅的地方；
              - `data-labels`：标签矩形，验「互不重叠、不越界」。
              没有这些就只能断言「canvas 有像素」。
            */}
            <div
              className="nexus-graph-hitmap"
              hidden
              data-nodes={JSON.stringify(
                layout.map((node) => ({
                  id: node.id,
                  x: Math.round(node.x),
                  y: Math.round(node.y)
                }))
              )}
              data-screen-nodes={JSON.stringify(
                graph.nodes.flatMap((node) => {
                  const position = positionById.get(node.id);
                  if (!position) return [];
                  const screen = projectPoint(view, position.x, position.y);
                  return [
                    { id: node.id, name: node.name, kind: node.kind, x: screen.x, y: screen.y }
                  ];
                })
              )}
              data-view={JSON.stringify(view)}
              data-active-node={activeNodeId === null ? '' : String(activeNodeId)}
              data-selected={selectedNode === null ? '' : String(selectedNode.id)}
              data-edges={JSON.stringify(
                graph.edges.map((edge) => ({
                  source: edge.source,
                  target: edge.target,
                  mutual: edge.mutual
                }))
              )}
              data-hover={JSON.stringify({
                id: hoveredId,
                neighbors: hoveredId === null ? [] : [...(neighborsById.get(hoveredId) ?? [])]
              })}
              data-labels={JSON.stringify(
                labelPlacements.map((placement) => ({
                  id: placement.id,
                  text: placement.text,
                  rect: {
                    left: Math.round(placement.rect.left),
                    top: Math.round(placement.rect.top),
                    right: Math.round(placement.rect.right),
                    bottom: Math.round(placement.rect.bottom)
                  }
                }))
              )}
            />

            {/*
              图例是 **DOM 而不是画在 canvas 上**：它是可以选中、可以读屏的东西，
              而 canvas 里画出来的文字两样都做不到。颜色值由绘制 effect 读出来传进来。
            */}
            {legend.length > 0 && (
              <div className="nexus-graph-legend">
                {/*
                  可见标题。此前这里只有 `aria-label` —— 屏幕上是一列彩色小方块 + 目录名，
                  新用户看不出那一列颜色是「按顶层目录分区」的意思。
                  `aria-label` 留在下面的 `ul` 上：标题是一段静态文字，列表自己还需要名字。
                */}
                <span className="nexus-graph-legend-title">{t('graph.legend.title')}</span>
                <ul className="nexus-graph-legend-list" aria-label={t('graph.legend.title')}>
                  {legend.map((row) => (
                    <li key={row.label} className="nexus-graph-legend-row" data-cluster={row.label}>
                      <span
                        className="nexus-graph-legend-swatch"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="nexus-graph-legend-label">{row.label}</span>
                      <span className="nexus-graph-legend-count">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
