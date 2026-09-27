import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // 兜底清理：测试若以任何方式在真实 userData 下生成了索引库，跑完就删掉。
    // 正常路径不会命中（harness 已按实例隔离 user-data-dir），详见该文件注释。
    globalSetup: ['apps/desktop/test/global-setup.ts'],
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
          // 同时匹配 .ts：renderer 层的纯逻辑（状态层、纯函数）没有 JSX，
          // 不该因为后缀被挡在测试之外。
          include: ['apps/desktop/renderer/test/**/*.test.{ts,tsx}']
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
          // 单条用例渲染整个 App 在空载下约 1s；真正卡死的用例仍会失败，只是晚一些。
          //
          // 60s 而不是 30s：这些用例要「启动 Electron + 跑完整交互链」，空载就 20–25s，
          // 全量串行跑到后半段机器负载上来，就会贴到 30s 上限而**假失败**
          // （outline-panel 30.06s、workspace-index 29.97s 都踩过）。
          testTimeout: 60000,
          // 300s 而不是 60s：**某些状态下**本机会「每删除一个目录慢 30 秒」——不是恒定环境事实，
          // 而是一次会自行消失的状态（2026-09-27 实测持续约 64 分钟，用户重启电脑后消失，
          // 同一份测试前后差 183 倍）。详见 .workbuddy-ai/memory/MEMORY.md 的
          // 「环境事实：**偶发**的『删目录慢 30 秒』状态」。
          //
          // 处于该状态时，「自带临时目录 + afterEach 删掉」的用例，hook 耗时 = 目录数 × 30s。
          // 实测 `workspace-boundary.test.ts` 的「跳过点开头的工具元数据目录」一条要删十几个目录，
          // 单条 150.6s —— 60s 下必报 `Hook timed out in 60000ms`，而**看起来像断言失败**
          // （失败项里会混进几条本次根本没碰过的旧用例，这是「环境问题而非代码问题」的判据）。
          // 正常状态下这些 hook 只要几毫秒，300s 不会拖慢任何东西，所以直接留大值兜住偶发。
          // 注意：project 级配置会覆盖 CLI 的 `--hookTimeout`，所以只能在这里改。
          hookTimeout: 300000
        }
      }
    ]
  }
});
