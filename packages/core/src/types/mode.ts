/**
 * Application execution modes.
 *
 * Currently Nexus Lite operates in 'lightweight' mode for single-file Markdown editing.
 * Architected to be easily extensible to:
 * type AppMode = 'lightweight' | 'viewer' | 'workspace';
 */
export type AppMode = 'lightweight';

/**
 * Application startup context shared between Electron main, preload, and renderer.
 */
export interface LaunchContext {
  /** Current operating mode of the application */
  mode: AppMode;
  /** Valid markdown file path to open, or null if no file specified */
  filePath: string | null;
  /** Unsupported file path if user attempted to open a non-markdown file */
  unsupportedPath: string | null;
}

/**
 * Default empty launch context.
 */
export const DEFAULT_LAUNCH_CONTEXT: Readonly<LaunchContext> = Object.freeze({
  mode: 'lightweight',
  filePath: null,
  unsupportedPath: null
});
