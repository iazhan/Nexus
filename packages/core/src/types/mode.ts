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
 * Default empty launch context.
 */
export const DEFAULT_LAUNCH_CONTEXT: Readonly<LaunchContext> = Object.freeze({
  mode: 'lightweight',
  filePath: null,
  documentType: null,
  workspaceRoot: null,
  unsupportedPath: null
});
