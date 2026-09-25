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
          name: 'renderer',
          globals: true,
          environment: 'happy-dom',
          include: ['apps/desktop/renderer/test/**/*.test.tsx']
        }
      },
      {
        test: {
          name: 'desktop',
          globals: true,
          environment: 'node',
          include: ['apps/*/test/**/*.test.ts'],
          // 这些用例会启动真实 Electron 实例（16 个文件 / 100 条用例，每条都要冷启动一次
          // Electron，约 7s）。并行执行时多个 Electron 互相争抢 CPU，产生随机超时：
          // 既掩盖真实失败，也对正常实现报假警。
          //
          // **不要用 `fileParallelism: false`** —— 它在 `ProjectConfig` 里属于
          // `NonProjectOptions`（vitest 3.2.7 的 `reporters.d.ts`），写在 project 里会被
          // **静默忽略**：日志里 `tests` 累计耗时（585s）远大于墙钟（146s），
          // 就是 4 路并行的证据。project 里唯一可用的并发旋钮是 `poolOptions`。
          //
          // `singleFork` = 所有文件跑在同一个 fork 进程里、串行排队。
          // 代价是失去模块隔离；若后续出现跨文件串味，改用根级 `maxWorkers: 1`
          // （保留隔离，但会连 unit/renderer 一起串行化）。
          poolOptions: {
            forks: {
              singleFork: true
            }
          },
          // 单条用例渲染整个 App 在空载下约 1s；真正卡死的用例仍会失败，只是晚 25s。
          testTimeout: 30000,
          hookTimeout: 30000
        }
      }
    ]
  }
});
