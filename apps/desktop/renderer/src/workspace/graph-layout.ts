import type { WorkspaceGraph } from '@nexus/core';

export interface GraphLayoutNode {
  id: number;
  x: number;
  y: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** 迭代次数。越多越稳定，也越慢。 */
  iterations?: number;
}

/**
 * 节点与画布边缘之间保留的最小距离。
 *
 * ## 为什么不能贴边
 *
 * 迭代里会把坐标钳进画布，不留边距的话最外圈的点正好落在 `x = 0` 或 `y = 0` 上：
 *
 * 1. 画出来是**半个点**（圆心在边上，半径那一半画到了画布外）；
 * 2. 标签放不下 —— 标签要占节点旁边一块矩形，贴边的点四个锚点全部越界，于是最外圈
 *    （恰恰是「孤立文档」「离群节点」这些最需要认出来的点）一个标签都拿不到。
 *
 * 留出「节点半径 + 一段空隙」就够，不需要按标签宽度留 —— 标签会自己换锚点。
 */
export const GRAPH_EDGE_PADDING = 14;

/**
 * 重心回拉的强度：每步给节点加一个 `(画布中心 - 节点位置) * GRAVITY` 的位移分量。
 *
 * ## 为什么是 1 这个量级，而不是「很小一点」
 *
 * 斥力是 `k²/d`（k 为理想边长），回拉是 `r * GRAVITY`。两者平衡时节点落在半径
 * `r = k * sqrt(c / GRAVITY)`（c 是节点数决定的一个常数，约 2）。
 * 也就是说**半径与 GRAVITY 的平方根成反比**：
 *
 * - `GRAVITY = 0.03` 时 r ≈ 8k —— 远大于画布，节点全被墙钳住。实测 4 个节点在
 *   240×575 里**三个停在底边排成一行**，图读起来像一根轴；
 * - `GRAVITY = 1` 时 r ≈ 1.4k，正好是「节点之间保持理想间距」的尺度 ——
 *   实测同一组输入铺在画布中部（y 从 133 到 351），不再贴边。
 *
 * 节点一多，斥力按对数增长、回拉按半径线性增长，平衡半径自动变大 ——
 * 所以这个值不需要随节点数调整。
 */
const GRAVITY = 1;

/**
 * 力导向布局（Fruchterman-Reingold 的简化版）。
 *
 * ## 为什么必须是确定性的
 *
 * 初始位置放在**圆环**上而不是随机撒点，迭代过程里也没有任何随机项。
 * 两个理由：
 *
 * 1. 图谱每次打开都长一样，用户才能记住「那篇文档在图上的位置」；
 *    每次重新随机的话，形状就只是噪音。
 * 2. 坐标可断言 —— 随机布局只能测「跑完了没抛错」。
 *
 * ## 与教科书版的差异
 *
 * 只保留了斥力（所有节点对）、引力（有边的节点对）、**重心回拉**和降温。
 * 没有做的是「按度数加权」这类精修 —— 对几百个节点的知识图谱够用，而且代码量小到
 * 能一眼看懂每步在做什么。
 *
 * 重心回拉不是装饰：少了它，斥力只往外推而没有任何回拉，节点会漂到边界被钳住，
 * 整张图贴在边上排成一条线。理由详见 GRAVITY 处的说明。
 */
export function layoutGraph(
  graph: WorkspaceGraph,
  { width, height, iterations = 300 }: LayoutOptions
): GraphLayoutNode[] {
  const count = graph.nodes.length;
  if (count === 0) return [];

  const centerX = width / 2;
  const centerY = height / 2;

  // 理想边长：把画布面积均分给节点后取一个方根。
  // 这是 Fruchterman-Reingold 里 k 的常用取法，量纲上正好是「长度」。
  const idealDistance = Math.sqrt((width * height) / count) * 0.6;

  // 初始位置：圆环上均匀铺开。
  // 这里也要钳一次边距 —— 迭代里那次钳位只在节点真的移动时才跑，而只有一两个节点时
  // 位移量恒为 0，钳位根本不会执行，圆环的半径就会把点留在画布外。
  const maxX = Math.max(GRAPH_EDGE_PADDING, width - GRAPH_EDGE_PADDING);
  const maxY = Math.max(GRAPH_EDGE_PADDING, height - GRAPH_EDGE_PADDING);
  const positions: GraphLayoutNode[] = graph.nodes.map((node, index) => {
    const angle = (2 * Math.PI * index) / count;
    const radius = Math.min(width, height) * 0.35;
    return {
      id: node.id,
      x: Math.max(GRAPH_EDGE_PADDING, Math.min(maxX, centerX + radius * Math.cos(angle))),
      y: Math.max(GRAPH_EDGE_PADDING, Math.min(maxY, centerY + radius * Math.sin(angle)))
    };
  });

  const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const edges: Array<readonly [number, number]> = [];
  for (const edge of graph.edges) {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    if (source !== undefined && target !== undefined) edges.push([source, target]);
  }

  let temperature = Math.min(width, height) * 0.1;

  for (let step = 0; step < iterations; step += 1) {
    const shiftX = new Array<number>(count).fill(0);
    const shiftY = new Array<number>(count).fill(0);

    // 斥力：所有节点对互相推开
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let deltaX = positions[i]!.x - positions[j]!.x;
        let deltaY = positions[i]!.y - positions[j]!.y;
        let distance = Math.hypot(deltaX, deltaY);

        // 两点完全重合时方向没有定义，给一个**确定性的**错开量
        if (distance < 0.01) {
          deltaX = (i - j) * 0.01;
          deltaY = 0.01;
          distance = Math.hypot(deltaX, deltaY);
        }

        const force = (idealDistance * idealDistance) / distance;
        const forceX = (deltaX / distance) * force;
        const forceY = (deltaY / distance) * force;

        shiftX[i]! += forceX;
        shiftY[i]! += forceY;
        shiftX[j]! -= forceX;
        shiftY[j]! -= forceY;
      }
    }

    // 引力：有边相连的节点互相拉近
    for (const [i, j] of edges) {
      let deltaX = positions[i]!.x - positions[j]!.x;
      let deltaY = positions[i]!.y - positions[j]!.y;
      let distance = Math.hypot(deltaX, deltaY);
      if (distance < 0.01) {
        deltaX = 0.01;
        deltaY = 0;
        distance = 0.01;
      }

      const force = (distance * distance) / idealDistance;
      const forceX = (deltaX / distance) * force;
      const forceY = (deltaY / distance) * force;

      shiftX[i]! -= forceX;
      shiftY[i]! -= forceY;
      shiftX[j]! += forceX;
      shiftY[j]! += forceY;
    }

    /*
      重心回拉：把所有节点往画布中心轻轻推。

      没有它的话，斥力只往外推、没有任何回拉，节点会一路漂到边界被钳住 ——
      实测 4 个节点在 240×575 的画布里**全部停在底边上排成一条线**，图读起来像一根
      轴而不是一张网。这不是「有点丑」：节点贴在边上时，标签的四个锚点里有两个越界，
      于是最外圈的点反而最不容易拿到标签。

      系数很小（相对斥力弱一个量级），只负责「别漂走」，不改变相对结构 ——
      相连的节点仍然比无关的更近（`graph-layout.test.ts` 守着这条）。
    */
    for (let i = 0; i < count; i += 1) {
      shiftX[i]! += (centerX - positions[i]!.x) * GRAVITY;
      shiftY[i]! += (centerY - positions[i]!.y) * GRAVITY;
    }

    // 位移量受当前温度限制，并夹在画布内
    for (let i = 0; i < count; i += 1) {
      const magnitude = Math.hypot(shiftX[i]!, shiftY[i]!);
      if (magnitude < 0.001) continue;

      const limited = Math.min(magnitude, temperature);
      const node = positions[i]!;
      node.x += (shiftX[i]! / magnitude) * limited;
      node.y += (shiftY[i]! / magnitude) * limited;
      // 钳进画布时留出边距，理由见 GRAPH_EDGE_PADDING
      node.x = Math.max(GRAPH_EDGE_PADDING, Math.min(maxX, node.x));
      node.y = Math.max(GRAPH_EDGE_PADDING, Math.min(maxY, node.y));
    }

    temperature *= 0.98;
  }

  return positions;
}
