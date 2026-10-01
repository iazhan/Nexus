import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sweepStaleTempDirs } from './smoke-harness';

/**
 * 索引库清理兜底。
 *
 * 正常路径下测试不会在真实 userData 里留东西：`smoke-harness` 给每个 Electron
 * 实例单独开 `--user-data-dir`，索引库落在 `%TEMP%` 的隔离目录里，随实例关闭
 * 一起删。
 *
 * 但这条路径依赖**每个用例都走 harness**。一旦有人直接启动 Electron、或者把
 * 索引路径改回真实 userData，库就会静默堆在
 * `%APPDATA%/@nexus/desktop/workspace-index/` 下 —— 实测堆到过 140 个，
 * 而目录一变大，`IndexStore.open` 和后续实例启动都会变慢，表现为
 * 「全量跑到后半段随机超时、单跑却总是通过」。
 *
 * 所以这里做一道**只删新增**的兜底：开跑前记下目录快照，跑完把多出来的
 * 索引产物删掉。原有的库（用户真实工作区的索引）一律不动。
 */
function workspaceIndexDir(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '@nexus', 'desktop', 'workspace-index');
}

/** 只认索引产物，避免误伤目录里的其他东西。 */
const INDEX_ARTIFACT = /\.db(-journal|-wal|\.lock)?$/;

function snapshot(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

export default function setup(): () => void {
  // 第二道兜底：`%TEMP%` 里的测试临时目录。放在这里是因为 globalSetup **每次跑只执行一次**，
  // 而 harness 自己的退出钩子只覆盖正常退出（理由见 `sweepStaleTempDirs` 的注释）。
  const swept = sweepStaleTempDirs();
  if (swept > 0) {
    console.log(`[temp-cleanup] 清掉 ${swept} 个超期残留目录（${os.tmpdir()}）`);
  }

  const dir = workspaceIndexDir();
  const before = snapshot(dir);
  console.log(`[index-cleanup] 兜底就绪：${dir}（现有 ${before.size} 项）`);

  return () => {
    const after = snapshot(dir);
    const added = [...after].filter((name) => !before.has(name) && INDEX_ARTIFACT.test(name));
    const removed: string[] = [];

    for (const name of added) {
      const full = path.join(dir, name);
      try {
        if (fs.lstatSync(full).isDirectory()) {
          // `.db.lock` 是 node-sqlite3-wasm 的目录锁，正常情况下是空的。
          // 用 rmdirSync 而不是 rm -r：非空会抛错，绝不递归删内容。
          fs.rmdirSync(full);
        } else {
          fs.rmSync(full, { force: true });
        }
        removed.push(name);
      } catch {
        // 删不掉（仍被占用）不该影响测试结论，留给下一次
      }
    }

    if (removed.length > 0) {
      console.log(
        `[index-cleanup] 清理了 ${removed.length} 个测试期间新增的索引产物：${removed.join(', ')}`
      );
    }
  };
}
