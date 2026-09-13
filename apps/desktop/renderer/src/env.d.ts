/// <reference types="vite/client" />

import type { NexusBridge } from '../../preload/types.js';

declare global {
  interface Window {
    nexus?: NexusBridge;
  }
}

export {};
