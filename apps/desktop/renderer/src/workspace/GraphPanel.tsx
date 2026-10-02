import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentType, GraphNode, WorkspaceGraph } from '@nexus/core';
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
import { HubsList, OrphansList } from './GraphLists.js';
import { iterationsForNodeCount, layoutGraph } from './graph-layout.js';
import { planGraphLabels, type GraphLabelCandidate, type GraphLabelPlacement } from './graph-labels.js';
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
  /** 当前活动文档的绝对路径，用于高亮它的节点 */
  activeFilePath: string | null;
  onOpenFile: (filePath: string) => void;
  /**
   * 点击**断链节点**时调用，参数是归一化后的链接目标（如 `notes/dma`）。
   *
   * 与 `onOpenFile` 分开是有意的：断链没有文件可打开，它对应的动作是**新建**。
   * 合成到一个回调里、靠「路径存不存在」分流的话，图谱这一层就要去查磁盘了。
   */
  onCreateMissingLink: (linkTarget: string) => void;
  /** 索引变化信号；变化时重读图 */
  revision: number;
}

/** 节点基础半径；实际半径再按 degree 增长（封顶，免得枢纽节点大到盖住别的）。 */
const NODE_RADIUS = 3;
const MAX_DEGREE_BONUS = 6;
/** 点击命中额外放宽的像素，手指不好精确点到 3px 的圆。 */
const HIT_SLACK = 4;

/** 标签最多画几条：按画布面积给，并夹在上下限之间。 */
const MIN_LABELS = 6;
const MAX_LABELS = 48;
/** 每一条标签大致占多少平方像素 —— 越小画得越多、越容易显得挤。 */
const LABEL_AREA_BUDGET_PX = 6000;
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
  revision
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

  const dragRef = useRef<DragState | null>(null);
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
  */
  const query = useMemo(
    () => ({
      centerPath: scope === 'current' ? (activeFilePath ?? undefined) : undefined,
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
        const full = (await window.nexus?.getGraph?.()) ?? { nodes: [], edges: [] };
        if (cancelled) return;
        const counts = new Map<DocumentType, number>();
        for (const node of full.nodes) {
          // 断链没有类型 —— 它们不该出现在类型筛选条上（没有「断链」这一类可关）
          if (node.kind !== 'document') continue;
          counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
        }
        setTypeCounts([...counts].map(([type, count]) => ({ type, count })));
      } catch (err) {
        console.error('Failed to load graph types:', err);
        if (!cancelled) setTypeCounts([]);
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
        const result = (await window.nexus?.getGraph?.(query)) ?? { nodes: [], edges: [] };
        if (!cancelled) setGraph(result);
      } catch (err) {
        console.error('Failed to load graph:', err);
        if (!cancelled) setGraph({ nodes: [], edges: [] });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision, query]);

  /*
    没有活动文档时退回全图。

    不退回的话，`scope` 还是 `'current'` 而 `centerPath` 是空的 —— 查询会按「没有中心」
    处理、返回全图，但按钮上仍然写着「当前文档」。界面说的和画出来的不一致，
    而用户只会觉得图谱没反应。
  */
  useEffect(() => {
    if (activeFilePath === null) setScope('all');
  }, [activeFilePath]);

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

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (drag === null) return;

    // 拖过了就不算点击 —— 否则拖完一个节点会顺手把它打开，把用户从图谱里踢出去
    if (drag.moved || drag.kind !== 'node' || drag.nodeId === null) return;

    const node = graph.nodes.find((candidate) => candidate.id === drag.nodeId);
    if (node === undefined) return;
    // 断链没有文件可打开 —— 它走的是「按这个目标名新建一篇」
    if (node.kind === 'missing') onCreateMissingLink(node.linkTarget);
    else onOpenFile(node.path);
  }, [graph.nodes, onOpenFile, onCreateMissingLink]);

  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
    setPanning(false);
    setHoveredId(null);
  }, []);

  /** 双击空白取景；双击节点时不取景（那是「打开文档」的位置）。 */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const point = screenPointOf(event);
      if (hitTest(point.x, point.y) !== null) return;
      setView(
        fitView(
          [...positionById.values()],
          { width: size.width, height: size.height },
          FIT_PADDING_PX
        )
      );
    },
    [hitTest, positionById, size.width, size.height]
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
    context.clearRect(0, 0, size.width, size.height);

    // 节点高亮是图形元素，走图形类阈值（3:1）的 accent-indicator，不是文字类的 accent-text
    const edgeColor = readColor(canvas, '--nexus-border-default');
    const activeColor = readColor(canvas, '--nexus-accent-indicator');
    // 活跃文档改用**描边**区分：填充已经被分区色占了，两个都用填充就分不出谁是谁
    const activeRingColor = readColor(canvas, '--nexus-text-primary');
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
    const isActiveNode = (node: GraphNode) =>
      node.kind === 'document' &&
      normalizedActive !== undefined &&
      node.relativePath.replace(/\\/g, '/') === normalizedActive;

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

    context.strokeStyle = edgeColor;
    context.lineWidth = 1;
    context.beginPath();
    for (const edge of graph.edges) {
      const source = toScreen(edge.source);
      const target = toScreen(edge.target);
      if (!source || !target) continue;
      context.globalAlpha = litIds !== null && !(litIds.has(edge.source) && litIds.has(edge.target)) ? DIM_ALPHA : 1;
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
    const arrowSize = clampArrowSize(view.scale);
    for (const edge of graph.edges) {
      const source = toScreen(edge.source);
      const target = toScreen(edge.target);
      if (!source || !target) continue;

      context.globalAlpha =
        litIds !== null && !(litIds.has(edge.source) && litIds.has(edge.target)) ? DIM_ALPHA : 1;
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

      const radius = nodeRadius(node) * view.scale;
      context.globalAlpha = litIds !== null && !litIds.has(node.id) ? DIM_ALPHA : 1;

      if (node.kind === 'missing') {
        /*
          断链画成**空心 + 虚线环**，不是实心点。
          只靠颜色区分不行：色觉障碍用户读不出「这个点还没建」，而虚线轮廓与填充是
          形状差异，任何配色下都成立。
        */
        context.beginPath();
        context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        context.strokeStyle = missingColor;
        context.lineWidth = 1.5;
        context.setLineDash([3, 2]);
        context.stroke();
        context.setLineDash([]);
      } else {
        context.beginPath();
        context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        context.fillStyle = colorForNode(node);
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
    }
    context.globalAlpha = 1;

    /*
      标签画在最后，且**不与节点共用颜色**：节点是图形（3:1 就够），标签是文字（要 4.5:1），
      两者用同一个 token 会让标签在浅色主题下糊在点里。
    */
    const labelColor = readColor(canvas, '--nexus-text-secondary');
    const activeLabelColor = readColor(canvas, '--nexus-text-primary');
    const fontFamily = getComputedStyle(canvas).fontFamily || 'sans-serif';
    context.font = `${LABEL_FONT_SIZE_PX}px ${fontFamily}`;
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
      maxLabels: Math.min(
        MAX_LABELS,
        Math.max(MIN_LABELS, Math.floor((size.width * size.height) / LABEL_AREA_BUDGET_PX))
      ),
      maxLabelWidthPx: Math.max(60, size.width * 0.4),
      measureTextWidth: (text) => context.measureText(text).width
    });

    for (const placement of placements) {
      context.globalAlpha = litIds !== null && !litIds.has(placement.id) ? DIM_ALPHA : 1;
      context.fillStyle = placement.isActive ? activeLabelColor : labelColor;
      context.fillText(placement.text, placement.textX, placement.textY);
    }
    context.globalAlpha = 1;

    /*
      悬停信息条。标签只给名字，所以这里补上「名字之外还需要知道的那一点」：
      普通节点是度数，断链是「它指向的文档还没建」—— 后者才是用户此刻的疑问。
    */
    const hovered = hoveredId === null ? null : graph.nodes.find((node) => node.id === hoveredId);
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

    setLabelPlacements(placements);
  }, [
    graph,
    layout,
    positionById,
    neighborsById,
    view,
    size,
    activeFilePath,
    hoveredId,
    t,
    // 换主题要重画 —— 画布的颜色是读出来定死在位图里的，不订阅就停在旧配色上
    resolvedTheme?.id
  ]);

  return (
    <div className="nexus-graph">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.graph')}</span>
        {/* 计数是**画布上**的节点数；清单视图里那个数由各自的列表回答，这里不重复 */}
        {mode === 'explore' && graph.nodes.length > 0 && (
          <span className="nexus-sidebar-count">{graph.nodes.length}</span>
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
            disabled={activeFilePath === null}
            title={activeFilePath === null ? t('graph.scopeCurrentUnavailable') : undefined}
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
          </>
        )}
      </div>

      {/*
        两个清单视图**不进画布那一层**：画布的尺寸由 ResizeObserver 量，
        而清单是普通流式布局，塞进 `.nexus-graph-body` 会把它撑成一个画布盒子。
      */}
      {mode === 'orphans' && (
        <OrphansList revision={revision} onOpenFile={onOpenFile} />
      )}
      {mode === 'hubs' && <HubsList revision={revision} onOpenFile={onOpenFile} />}

      {/*
        这一层是**画布的盒子**：尺寸由它量、绘制坐标也以它为准（见上面 ResizeObserver 的说明）。
        它必须始终存在（空态时也在），否则 `[]` 依赖的观察 effect 首次挂载时拿到 null，
        之后图谱有数据了也不会重新观察。
      */}
      <div className="nexus-graph-body" ref={containerRef} hidden={mode !== 'explore'}>
        {graph.nodes.length === 0 ? (
          /*
            两种「空」必须分开：本来就没什么可画，和**被筛空了**。
            后者要给一条出路（「显示全部」）—— 否则用户面对一张空画布，只能靠猜是哪个开关干的。
            与文件树的过滤规则是同一条判据。
          */
          hasTypeFilter ? (
            <p className="nexus-sidebar-note">
              {t('graph.filteredEmpty')}
              <button
                type="button"
                className="nexus-graph-reset"
                onClick={() => {
                  setHiddenTypes([]);
                  setScope('all');
                }}
              >
                {t('graph.resetFilters')}
              </button>
            </p>
          ) : (
            <p className="nexus-sidebar-note">{t('graph.empty')}</p>
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
              <ul className="nexus-graph-legend" aria-label={t('graph.legend.title')}>
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
            )}
          </>
        )}
      </div>
    </div>
  );
};
