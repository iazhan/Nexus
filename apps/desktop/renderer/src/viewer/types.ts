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
