/**
 * Application execution modes.
 *
 * 模式只决定「启动时加载什么」，不决定「保存成什么」—— 保存永远写回 Markdown source。
 *
 * - `lightweight`：直接打开单个 Markdown 文件。默认不加载索引、图谱和同步。
 * - `viewer`：直接打开 PDF / DOCX / 图片等文档。由 Phase 3 的 Document Center 产出，
 *   当前没有任何启动路径会进入这个模式（类型先立，避免 Phase 3 再改一次公共契约）。
 * - `workspace`：打开一个工作区目录，启用 Vault、索引与知识库能力。
 */
export type AppMode = 'lightweight' | 'viewer' | 'workspace';

/**
 * Application startup context shared between Electron main, preload, and renderer.
 */
export interface LaunchContext {
  /** Current operating mode of the application */
  mode: AppMode;
  /** Valid markdown file path to open in lightweight mode, or null */
  filePath: string | null;
  /** Workspace root directory to open in workspace mode, or null */
  workspaceRoot: string | null;
  /** Unsupported file path if user attempted to open a non-markdown file */
  unsupportedPath: string | null;
}

/**
 * Default empty launch context.
 */
export const DEFAULT_LAUNCH_CONTEXT: Readonly<LaunchContext> = Object.freeze({
  mode: 'lightweight',
  filePath: null,
  workspaceRoot: null,
  unsupportedPath: null
});
