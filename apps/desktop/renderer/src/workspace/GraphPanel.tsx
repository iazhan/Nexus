import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceGraph } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { layoutGraph } from './graph-layout.js';

export interface GraphPanelProps {
  /** 当前活动文档的绝对路径，用于高亮它的节点 */
  activeFilePath: string | null;
  onOpenFile: (filePath: string) => void;
  /** 索引变化信号；变化时重读图 */
  revision: number;
}

/** 节点基础半径；实际半径再按 degree 增长（封顶，免得枢纽节点大到盖住别的）。 */
const NODE_RADIUS = 3;
const MAX_DEGREE_BONUS = 6;
/** 点击命中额外放宽的像素，手指不好精确点到 3px 的圆。 */
const HIT_SLACK = 4;

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

/** 图谱面板：把工作区的链接关系画成一张图。 */
export const GraphPanel: React.FC<GraphPanelProps> = ({ activeFilePath, onOpenFile, revision }) => {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<WorkspaceGraph>({ nodes: [], edges: [] });
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = (await window.nexus?.getGraph?.()) ?? { nodes: [], edges: [] };
        if (!cancelled) setGraph(result);
      } catch (err) {
        console.error('Failed to load graph:', err);
        if (!cancelled) setGraph({ nodes: [], edges: [] });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  // 跟随容器尺寸。侧栏可以拖宽，布局要跟着重算，否则图会挤在旧尺寸的画布里。
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

  const layout = useMemo(() => {
    if (size.width <= 0 || size.height <= 0) return [];
    return layoutGraph(graph, { width: size.width, height: size.height });
  }, [graph, size.width, size.height]);

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
    const nodeColor = readColor(canvas, '--nexus-text-muted');
    const activeColor = readColor(canvas, '--nexus-accent-indicator');

    const positionById = new Map(layout.map((node) => [node.id, node]));

    context.strokeStyle = edgeColor;
    context.lineWidth = 1;
    context.beginPath();
    for (const edge of graph.edges) {
      const source = positionById.get(edge.source);
      const target = positionById.get(edge.target);
      if (!source || !target) continue;
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
    }
    context.stroke();

    const normalizedActive = activeFilePath?.replace(/\\/g, '/');
    for (const node of graph.nodes) {
      const position = positionById.get(node.id);
      if (!position) continue;

      const isActive = normalizedActive !== undefined &&
        node.relativePath.replace(/\\/g, '/') === normalizedActive;

      context.beginPath();
      context.arc(
        position.x,
        position.y,
        NODE_RADIUS + Math.min(node.degree, MAX_DEGREE_BONUS),
        0,
        Math.PI * 2
      );
      context.fillStyle = isActive ? activeColor : nodeColor;
      context.fill();
    }
  }, [graph, layout, size, activeFilePath]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // 取**最近**的命中，而不是第一个命中的：节点密集处第一个往往是视觉上的邻居
      let hit: { path: string; distance: number } | null = null;

      for (const node of graph.nodes) {
        const position = layout.find((item) => item.id === node.id);
        if (!position) continue;

        const distance = Math.hypot(position.x - x, position.y - y);
        const radius = NODE_RADIUS + Math.min(node.degree, MAX_DEGREE_BONUS) + HIT_SLACK;
        if (distance <= radius && (hit === null || distance < hit.distance)) {
          hit = { path: node.path, distance };
        }
      }

      if (hit) onOpenFile(hit.path);
    },
    [graph.nodes, layout, onOpenFile]
  );

  return (
    <div className="nexus-graph" ref={containerRef}>
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.graph')}</span>
        {graph.nodes.length > 0 && (
          <span className="nexus-sidebar-count">{graph.nodes.length}</span>
        )}
      </div>

      {graph.nodes.length === 0 ? (
        <p className="nexus-sidebar-note">{t('graph.empty')}</p>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="nexus-graph-canvas"
            role="img"
            aria-label={t('graph.title')}
            onClick={handleClick}
          />
          {/*
            布局坐标暴露给测试。canvas 画出来的点从外部没法定位，
            而「点某个节点能打开文档」这条链路值得端到端验证 ——
            没有它就只能断言「canvas 有像素」。
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
          />
        </>
      )}
    </div>
  );
};
