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
 * 只保留了斥力（所有节点对）、引力（有边的节点对）和降温，没有做重心回拉。
 * 对几百个节点的知识图谱够用，而且代码量小到能一眼看懂每步在做什么。
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

  // 初始位置：圆环上均匀铺开
  const positions: GraphLayoutNode[] = graph.nodes.map((node, index) => {
    const angle = (2 * Math.PI * index) / count;
    const radius = Math.min(width, height) * 0.35;
    return {
      id: node.id,
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
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

    // 位移量受当前温度限制，并夹在画布内
    for (let i = 0; i < count; i += 1) {
      const magnitude = Math.hypot(shiftX[i]!, shiftY[i]!);
      if (magnitude < 0.001) continue;

      const limited = Math.min(magnitude, temperature);
      const node = positions[i]!;
      node.x += (shiftX[i]! / magnitude) * limited;
      node.y += (shiftY[i]! / magnitude) * limited;
      node.x = Math.max(0, Math.min(width, node.x));
      node.y = Math.max(0, Math.min(height, node.y));
    }

    temperature *= 0.98;
  }

  return positions;
}
