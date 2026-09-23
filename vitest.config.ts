import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts']
        }
      },
      {
        test: {
          name: 'desktop',
          globals: true,
          environment: 'node',
          include: ['apps/*/test/**/*.test.ts'],
          // 这些用例会启动真实 Electron 实例。并行执行时多个 Electron 会互相争抢资源，
          // 产生随机超时：既会掩盖真实失败，也会对正常实现报假警。按文件串行执行。
          fileParallelism: false
        }
      }
    ]
  }
});
