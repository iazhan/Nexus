import { contextBridge, ipcRenderer } from 'electron';
import type { LaunchContext } from '@nexus/core';
import type { NexusBridge } from './types.js';

const bridge: NexusBridge = {
  getLaunchContext: (): Promise<LaunchContext> => {
    return ipcRenderer.invoke('nexus:get-launch-context');
  }
};

// Safely expose typed bridge in renderer main world
contextBridge.exposeInMainWorld('nexus', bridge);
