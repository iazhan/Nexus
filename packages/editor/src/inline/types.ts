import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownDocumentSession } from '../document-session.js';

export type InlineEditNodeType = 'link' | 'image' | 'inline-code' | 'wikilink';

export interface InlineEditContext {
  nodeType: InlineEditNodeType;
  range: { from: number; to: number };
  raw: string;
  source: string;
}

export interface LinkEditValue {
  label: string;
  destination: string;
  title?: string;
  syntax?: 'inline' | 'angle' | 'autolink';
}

export interface ImageEditValue {
  alt: string;
  destination: string;
  title?: string;
}

export interface InlineCodeEditValue {
  value: string;
}

export interface WikiLinkEditValue {
  target: string;
  alias?: string;
}

export interface ImageEditContext {
  range: { from: number; to: number };
  raw: string;
  alt: string;
  destination: string;
  title?: string;
}

export type ImageSourceResolver = (
  currentSource: string,
  context: ImageEditContext
) => Promise<string | null> | string | null;

/**
 * 工作区里可供选取的一张图片。
 *
 * 三个字段都是**宿主算好的成品**：编辑器既不知道文档目录在哪，也不知道 `nexus-asset://`
 * 的 URL 形状 —— 与 `LinkNavigator` / `ImageSourceResolver` 同一条分层纪律。
 */
export interface WorkspaceImageOption {
  /** 写进 `![](…)` 的地址：**相对当前文档目录**（标准 Markdown 的基准，只此一档）。 */
  readonly path: string;
  /**
   * 写进 `![[…]]` 的地址：Obsidian 的**最短唯一路径** —— 文件名全库唯一时是裸名，
   * 否则是工作区根相对路径。
   *
   * 与 `path` 必须分成两份：嵌入的**解析**走回退链，两种写法都找得到，但**写出去**的
   * 那一份要与 Obsidian 自己写的一致，否则同一篇笔记在两个工具里来回编辑会被反复改写。
   */
  readonly wikiPath: string;
  /** 列表里显示的名字。 */
  readonly name: string;
  /** 缩略图地址，宿主拼好的资源 URL。 */
  readonly url: string;
}

/**
 * 工作区图片列表的来源。返回空数组表示「工作区里没有图片」——那与「没有工作区」
 * （宿主干脆不提供这个钩子）是两件事，面板上的文案不同。
 */
export type WorkspaceImageProvider = () =>
  | Promise<readonly WorkspaceImageOption[]>
  | readonly WorkspaceImageOption[];

export interface InlineEditExtensionOptions {
  imageSourceResolver?: ImageSourceResolver;
  workspaceImages?: WorkspaceImageProvider;
  surfaceId?: string;
}

export const inlineEditOptionsFacet = Facet.define<InlineEditExtensionOptions, InlineEditExtensionOptions>({
  combine: (values) => values[0] ?? {}
});

export interface ActivePopoverState {
  view: EditorView;
  session: MarkdownDocumentSession;
  context: InlineEditContext;
  initialRevision: number;
  popoverEl: HTMLElement;
  targetEl: HTMLElement;
  cleanupListeners: () => void;
  committed: boolean;
  /**
   * 图片选择器面板当前指向的区间。
   *
   * 面板**不会**因为文档变化就关掉 —— 用户可能正在就地改地址，改完还要从列表里挑一张。
   * 于是区间必须跟着事务映射，否则一次输入之后所有坐标都错位，选中的图片会插到别处。
   * 表单浮层（`kind === 'form'`）没有这个字段：它一旦文档变化就关。
   */
  pickerRange?: { from: number; to: number };
  /**
   * 图片选择器按**当前输入的地址**重算列表。
   *
   * 列表内容跟着源码里那条引用的地址走：用户一边改地址，列表一边收敛到匹配的图，
   * 所以文档一变就得重算。它与 `pickerRange` 是同一件事的两半 ——
   * 区间负责「写到哪儿」，这个负责「列出什么」。
   */
  refreshList?: () => void;
}

