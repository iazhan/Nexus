import type { ComponentType } from 'react';
import type { ViewerDocumentType } from '@nexus/core';

/**
 * 交给渲染器的最小文档描述。
 *
 * 刻意**不把 `WorkspaceDocument` 递进去**：渲染器需要的是「哪个文件、叫什么、
 * 什么类型」，而 store 里那份还带着 saveState / session / readOnly ——
 * 一旦渲染器能碰到 `session`，就会有人开始往只读文档里写东西。
 * 收窄成描述对象，是把「Viewer 严格只读」变成类型上的事实（验收第 3 条）。
 */
export interface ViewerDocumentDescriptor {
  /** 绝对路径。资源加载（`nexus-asset://`）与页码引用都用它。 */
  readonly path: string;
  /** 文件名（含扩展名），供渲染器显示。 */
  readonly name: string;
  readonly type: ViewerDocumentType;
  /**
   * 打开时要定位到的页码（`#page=` 锚点解析出来的），`null` = 从第一页开始。
   *
   * 放进描述对象而不是让渲染器自己去读链接：渲染器只该知道「打开哪一份、翻到第几页」，
   * 「这个页码是从哪来的」是宿主的策略。同一份 PDF 已经开着时，宿主换掉这个值即可，
   * 渲染器不需要重挂载（`ViewerSurface` 的 key 是路径，换页不换 key）。
   */
  readonly page: number | null;
  /**
   * 生成引用时算相对路径的基准目录 —— 有工作区时是工作区根，轻量模式下是文档所在目录。
   *
   * 由宿主算好传进来：渲染器拿不到工作区根，也不该去猜「相对谁」。蓝图 §11.4 要求
   * 引用里的路径相对**工作区**，所以这个基准不能是渲染器自己的 `path` 的目录。
   */
  readonly citationBase: string;
}

/**
 * 所有 Viewer 渲染器的统一契约。
 *
 * Phase 3 的渲染器（图片 / PDF / DOCX）都由宿主传入同一个描述对象，
 * 自己只负责把 `path` 变成像素 —— 不碰 store、不碰 IPC 通道形状。
 */
export interface ViewerRendererProps {
  readonly document: ViewerDocumentDescriptor;
}

/**
 * 渲染器模块的形状。
 *
 * 约定默认导出，是因为这样注册处只需要一行
 * `load: () => import('./image/ImageRenderer.js')` —— 少一层解构就少一处
 * 改包名时忘记同步的地方。
 */
export interface ViewerRendererModule {
  readonly default: ComponentType<ViewerRendererProps>;
}
