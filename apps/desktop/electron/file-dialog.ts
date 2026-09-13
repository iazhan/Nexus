import type { BrowserWindow } from 'electron';

/** 文件对话框的可选配置。 */
export interface FileDialogOptions {
  /** 默认选中的文件或目录路径 */
  defaultPath?: string;
  /** 对话框标题 */
  title?: string;
  /** 文件过滤规则 */
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** 主进程文件对话框的最小抽象，便于在测试中注入取消或指定路径。 */
export interface FileDialog {
  openFile: (options?: FileDialogOptions) => Promise<string | null>;
  saveFile: (options?: FileDialogOptions) => Promise<string | null>;
}

/**
 * 创建基于 Electron 原生 dialog 的实现。
 * 动态加载 electron 模块，避免在纯 Node.js 测试环境下引发错误。
 */
export function createElectronFileDialog(browserWindow?: BrowserWindow): FileDialog {
  return {
    async openFile(options?: FileDialogOptions): Promise<string | null> {
      const electron = await import('electron');
      const dialog = electron.dialog;
      const opts = {
        title: options?.title ?? '打开 Markdown 文件',
        defaultPath: options?.defaultPath,
        filters: options?.filters ?? [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        properties: ['openFile' as const]
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    },
    async saveFile(options?: FileDialogOptions): Promise<string | null> {
      const electron = await import('electron');
      const dialog = electron.dialog;
      const opts = {
        title: options?.title ?? '另存为',
        defaultPath: options?.defaultPath,
        filters: options?.filters ?? [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      };
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, opts)
        : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) {
        return null;
      }
      return result.filePath;
    }
  };
}
