import type {
  LaunchContext,
  FileDocument,
  FileWatchListener,
  Unsubscribe
} from '@nexus/core';

export interface NexusBridge {
  getLaunchContext: () => Promise<LaunchContext>;
  openFile: (filePath?: string) => Promise<FileDocument>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  saveAs: (content: string) => Promise<string>;
  watchFile: (filePath: string, listener: FileWatchListener) => Unsubscribe;
  setDirty: (isDirty: boolean) => void;
  onSaveAndCloseRequested: (callback: () => Promise<void>) => Unsubscribe;
  readyToClose: () => void;
  closeWindow: () => void;
}
