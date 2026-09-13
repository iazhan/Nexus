import type { LaunchContext } from '@nexus/core';

export interface NexusBridge {
  getLaunchContext: () => Promise<LaunchContext>;
}
