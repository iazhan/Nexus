import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView, InlineFormat } from '@nexus/editor';
import {
  BoldIcon,
  ClearFormatIcon,
  HighlightIcon,
  InlineCodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikeIcon
} from '../components/format-icons.js';

/**
 * 选区上下文条：选中一段文字时贴着选区浮出的一排行内格式按钮。
 *
 * ## 为什么不跟常驻栏合一个组件
 *
 * 常驻栏按**正常流**占一行（见 `EditorToolbar` 的说明），它的问题是「一直在」；
 * 这一条是**浮层**，问题是「贴哪儿」。两者的定位机制、关闭来源、生命周期都不一样，
 * 合成一个组件的结果是里面到处是 `if (floating)`。共用的是**动作**，不是容器 ——
 * 动作走宿主命令，两条栏各自调用 `runCommand`，同一份实现（蓝图 `:394`）。
 *
 * ## 为什么是 `position: fixed`
 *
 * 与 `ContextMenu` 同一条理由：`fixed` 的定位基准是视口，**不受祖先 `overflow` 裁剪**。
 * 编辑区的滚动容器是 `overflow: auto`，用 `absolute` 的话选区一滚到边上这条就被裁掉，
 * 而它恰恰应该在视口里跟着走。
 *
 * ## 锚点由调用方量好传进来
 *
 * 组件只认**视口坐标的包围盒**（`anchor`），不知道 CodeMirror 的存在。这么做有两个好处：
 * ① 定位逻辑成了纯函数（`placeSelectionToolbar`），量不到排版的 happy-dom 里也能测；
 * ② 组件测试不必造一个真实编辑器，直接给一个矩形就能断言翻不翻转、点外部关不关。
 * 「怎么从 view 量出这个矩形」在 `useSelectionAnchor` 里，那是另一件事。
 *
 * ## 翻转与夹边
 *
 * 选区在可用区域顶部时上方放不下，翻到选区**下方**；横向以选区中心对齐、并夹在边距内。
 * 判据是「`top` 与选区 `bottom` 的关系」，不是「有没有某个 class」——
 * 后者只说明代码走到了哪一支，不说明用户看到的位置对不对。
 *
 * **可用区域的上沿不是视口顶边，而是编辑器自己的顶边**（`minTop`）。真机上量过一次：
 * 只按视口算的话，选中**首行**时条会翻在视口里、正好压住编辑器工具栏那一排
 * （撤销 / 重做 / 模式切换…），用户点不到它们。那一排不是正文的一部分，
 * 条没有理由盖在上面。
 *
 * ## 关闭：只认「点外部」
 *
 * 用**捕获阶段**的 `pointerdown`，且跳过条内部的按下 —— 否则条自己会被先卸掉，
 * 按钮的 `click` 永远到不了（`ContextMenu` 踩过同一个坑）。
 * 选区塌陷时**不在这里处理**：那时 `anchor` 变成 `null`，整条自然不画（见 `useSelectionAnchor`）。
 *
 * ## 焦点保持
 *
 * 与 `EditorToolbar` 逐字相同的一条：`mousedown` 上拦主键。拦在 `click` 上没用，
 * 那时焦点早换过手了，命令读到的选区是空的 —— 表现成「点了没反应」。
 */

/** 选区包围盒（视口坐标）。 */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 一次量测的两个结果：选区在哪、条最多能占到哪。 */
export interface SelectionAnchor {
  rect: AnchorRect;
  /**
   * 条的上沿不得高于这里（视口坐标）。取编辑器自己的顶边 ——
   * 上面那一条常驻工具栏不属于正文，见文件头的「翻转与夹边」。
   */
  minTop: number;
}

export interface ToolbarPlacement {
  top: number;
  left: number;
  /** 上方放不下、翻到了选区下方。 */
  flipped: boolean;
}

/** 条与选区之间、条与可用区域边缘之间的呼吸位。 */
const GAP = 8;
const MARGIN = 8;

/**
 * 算出条该放在哪。纯函数，不读 DOM —— 尺寸与可用区域都由调用方量好传进来。
 *
 * `flipped` 的判据是「**按上方算出来的 `top` 越过了上沿**」，而不是「选区 `top` 很小」：
 * 条本身有高度，选区贴着顶边但条很矮时，上方其实放得下。
 */
export function placeSelectionToolbar(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  minTop = 0
): ToolbarPlacement {
  const upperBound = Math.max(MARGIN, minTop);
  const above = anchor.top - GAP - size.height;
  const flipped = above < upperBound;
  const centered = anchor.left + (anchor.right - anchor.left) / 2 - size.width / 2;
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  // 翻到下方之后仍可能出底：夹回可用范围内，宁可压住一行正文也别飘到视口外面。
  const belowTop = Math.min(anchor.bottom + GAP, viewport.height - size.height - MARGIN);
  return {
    top: flipped ? Math.max(upperBound, belowTop) : above,
    left: Math.min(Math.max(MARGIN, centered), maxLeft),
    flipped
  };
}

/**
 * 量出当前选区在视口里的包围盒。没有非空选区、或量不到排版时返回 `null`。
 *
 * `revision` 只是「该重量了」的信号（宿主把它的选区状态传进来即可）——
 * **真实位置永远现读 `view.state.selection`**，不缓存：缓存的选区会在
 * 「宿主还没收到变更通知」的那个窗口里指向旧位置。
 *
 * 监听 `scroll` / `resize` 重量而不隐藏：条是 `fixed` 的，不跟着内容走，
 * 不重量就会浮在一个和选区无关的位置上（`ContextMenu` 选择关闭，那是因为菜单
 * 一次性的；这条要跟着选区一直在）。
 */
export function useSelectionAnchor(
  view: EditorView | null,
  revision: unknown
): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);

  useEffect(() => {
    if (!view) {
      setAnchor(null);
      return;
    }

    const measure = () => {
      const main = view.state.selection.main;
      const from = Math.min(main.anchor, main.head);
      const to = Math.max(main.anchor, main.head);
      if (from === to) {
        setAnchor(null);
        return;
      }
      // happy-dom（组件测试）没有排版引擎，`coordsAtPos` 恒返回 `null`（实测）。
      // 量不到就当没有锚点 —— 不画，比让整个渲染进程挂掉好。
      try {
        const start = view.coordsAtPos(from);
        const end = view.coordsAtPos(to, -1);
        if (!start || !end) {
          setAnchor(null);
          return;
        }
        // 编辑器自己的盒子决定上沿。量不到高度（没排版）时退回 0 ——
        // 那就退化成「按视口算」，正是这一条之前的行为。
        const editor = view.dom.getBoundingClientRect();
        setAnchor({
          rect: {
            top: Math.min(start.top, end.top),
            bottom: Math.max(start.bottom, end.bottom),
            left: Math.min(start.left, end.left),
            right: Math.max(start.right, end.right)
          },
          minTop: editor.height > 0 ? editor.top : 0
        });
      } catch {
        setAnchor(null);
      }
    };

    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [view, revision]);

  return anchor;
}

export interface SelectionAction {
  /** 同时是 `data-action` 与宿主命令 id。 */
  id: string;
  label: string;
  icon: React.ReactNode;
  /** 选区落在代码块 / 行内代码 / 公式里时，格式动作无处可施。 */
  disabled?: boolean;
  /** 激活态。**视觉与 `aria-pressed` 从这一个布尔派生**，不许各判一次。 */
  pressed?: boolean;
}

/**
 * 动作表。**这张表就是 §3.1 上表的唯一出处** —— 组件测试直接断言它的 id 序列，
 * 删掉一项就会红。
 *
 * `format` 是激活态要查的那个行内标记。没有这一栏的（插入链接 / 清除格式）不参与激活态：
 * 它们不是一个「开着的状态」，宣布成「未按下」是在编造一个不存在的东西。
 *
 * **链接只有一项，不是「link」+「wikilink」两项。** 写法由 `files.linkFormat` 决定，
 * 动作只负责「插一条指向工作区文档的链接」；要让某一条链接临时换写法，用 `/` 片段面板
 * （那两条模板刻意保留着，见 `docs/insert-link-and-link-format-proposal.md` §5 的结论）。
 * 拆成两个按钮的话，设置项与按钮会同时决定同一件事，用户看到的是两个互相打架的开关。
 */
export interface SelectionActionSpec {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
  format?: InlineFormat;
}

export const SELECTION_ACTION_SPECS: readonly SelectionActionSpec[] = [
  { id: 'format.bold', labelKey: 'cmd.bold', icon: BoldIcon, format: 'strong' },
  { id: 'format.italic', labelKey: 'cmd.italic', icon: ItalicIcon, format: 'emphasis' },
  { id: 'format.strike', labelKey: 'cmd.strike', icon: StrikeIcon, format: 'strike' },
  { id: 'format.highlight', labelKey: 'cmd.highlight', icon: HighlightIcon, format: 'highlight' },
  { id: 'format.inline-code', labelKey: 'cmd.inlineCode', icon: InlineCodeIcon, format: 'inline-code' },
  { id: 'format.insert-link', labelKey: 'cmd.insertLink', icon: LinkIcon },
  { id: 'format.clear-formatting', labelKey: 'cmd.clearFormatting', icon: ClearFormatIcon }
];

export interface SelectionToolbarProps {
  /** 量测结果。`null` = 不画（没有非空选区，或量不到排版）。 */
  anchor: SelectionAnchor | null;
  actions: readonly SelectionAction[];
  /** 动作的**标签**由调用方给（它才知道对应哪条命令），这里只负责画。 */
  label: string;
  onAction(id: string): void;
  onDismiss(): void;
}

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  anchor,
  actions,
  label,
  onAction,
  onDismiss
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ToolbarPlacement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPlacement(null);
      return;
    }
    const rect = barRef.current?.getBoundingClientRect();
    setPlacement(
      placeSelectionToolbar(
        anchor.rect,
        { width: rect?.width ?? 0, height: rect?.height ?? 0 },
        { width: window.innerWidth, height: window.innerHeight },
        anchor.minTop
      )
    );
  }, [anchor, actions.length]);

  useEffect(() => {
    if (!anchor) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [anchor, onDismiss]);

  if (!anchor) return null;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={label}
      className="nexus-selection-toolbar"
      data-selection-toolbar=""
      {...(placement?.flipped ? { 'data-flipped': '' } : {})}
      // 未量出尺寸前不画，否则会在 (0,0) 闪一下。尺寸是同步量到的，两帧之间没有可见间隔。
      style={placement ? { left: placement.left, top: placement.top } : { visibility: 'hidden' }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
      }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`nexus-toolbar-button${action.pressed ? ' nexus-toolbar-button-on' : ''}`}
          data-action={action.id}
          title={action.label}
          aria-label={action.label}
          aria-pressed={action.pressed === undefined ? undefined : action.pressed}
          aria-disabled={action.disabled ? 'true' : undefined}
          disabled={action.disabled}
          onClick={() => onAction(action.id)}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
};
