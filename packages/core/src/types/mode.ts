import type { DocumentType } from '../document/types.js';

/**
 * Application execution modes.
 *
 * 模式只决定「启动时加载什么」，不决定「保存成什么」—— 保存永远写回 Markdown source。
 *
 * - `lightweight`：直接打开单个 Markdown 文件。默认不加载索引、图谱和同步。
 * - `viewer`：直接打开 PDF / DOCX / 图片等文档（Phase 3 Document Center）。
 *   与 `lightweight` 的关键区别：这些文档是**严格只读**的，没有编辑与保存路径。
 * - `workspace`：打开一个工作区目录，启用 Vault、索引与知识库能力。
 */
export type AppMode = 'lightweight' | 'viewer' | 'workspace';

/**
 * Application startup context shared between Electron main, preload, and renderer.
 */
export interface LaunchContext {
  /** Current operating mode of the application */
  mode: AppMode;
  /**
   * 要打开的文档路径。
   * - `lightweight`：Markdown 文件
   * - `viewer`：PDF / DOCX / 图片
   * - `workspace`：`null`（工作区模式没有「单个要打开的文档」，文档由文件树选择）
   */
  filePath: string | null;
  /**
   * `filePath` 对应的文档类型。
   *
   * - 有 `filePath` 时必定非 null
   * - 没有 `filePath`（workspace 模式、空启动）时为 null
   *
   * **判「当前是哪个模式」请用 `mode`**，不要拿这个字段反推 ——
   * 两者只是恰好相关，`viewer` 的判据是模式而不是类型。
   */
  documentType: DocumentType | null;
  /** Workspace root directory to open in workspace mode, or null */
  workspaceRoot: string | null;
  /** Unsupported file path if user attempted to open a file outside the whitelist */
  unsupportedPath: string | null;
}

/**
 * 没有可用的启动参数时的上下文：**工作区模式**，还没定目录。
 *
 * 双击桌面图标裸启动走的就是这一条。把它定为 `lightweight` 会让裸启动落到一个
 * 没有路径的空编辑器上 —— 而「启动 Nexus」正是工作区模式的触发方式之一，
 * 空编辑器是它最不想要的形态（一个既不是文件、也不是工作区的中间态）。
 *
 * 开哪个目录由启动时的回落补上（先看显式参数、再看上次的工作区）；补不上时
 * 渲染进程给一个选目录的欢迎态，而不是悄悄退回空编辑器。
 *
 * 注意 `filePath` 为 `null` **不等于**这个上下文：`viewer` / `lightweight` 各自
 * 都可能有 `null` 路径。判「是不是裸启动」要三个字段一起看，见 `applyRecentWorkspace`。
 */
export const DEFAULT_LAUNCH_CONTEXT: Readonly<LaunchContext> = Object.freeze({
  mode: 'workspace',
  filePath: null,
  documentType: null,
  workspaceRoot: null,
  unsupportedPath: null
});
