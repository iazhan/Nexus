#!/usr/bin/env node
/**
 * 以**工作区模式**启动开发环境。
 *
 * 用法：
 *   pnpm dev:workspace "D:\Notes"
 *
 * 为什么需要这个脚本：`electron-vite dev` 的 CLI 只认自己的选项，没有把额外参数
 * 透传给 Electron 的官方途径 —— 所以 `pnpm dev "D:\Notes"` 是**不生效**的。
 * 这里改为设置 `NEXUS_WORKSPACE` 环境变量，由 main 进程读取
 * （见 `electron/index.ts` 的 `applyWorkspaceEnvOverride`）。
 *
 * 用 node 设置环境变量而不是 shell 语法，是为了在 Git Bash / cmd / PowerShell 下行为一致：
 * `FOO=bar pnpm dev` 这种写法只在 bash 里成立。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];

if (!target) {
  console.error('用法: pnpm dev:workspace <工作区目录>');
  console.error('例如: pnpm dev:workspace "D:\\Notes"');
  process.exit(1);
}

const resolved = path.resolve(target);

// 同步 fs 调用没问题：这里禁的是同步**进程创建**（execSync 恒 EBUSY），fs 不受影响
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
  console.error(`不是有效目录: ${resolved}`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log(`[dev:workspace] 工作区 = ${resolved}`);

const child = spawn('pnpm', ['--filter', '@nexus/desktop', 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXUS_WORKSPACE: resolved }
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
