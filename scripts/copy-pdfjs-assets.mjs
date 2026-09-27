#!/usr/bin/env node
/**
 * 把 pdfjs-dist 的静态资源复制到 renderer 的静态目录（P3-07）。
 *
 * 为什么需要这一步：PDF.js 要三样**运行时资源**，它们不能像普通依赖那样被
 * 打包进 JS：
 *
 *   - `cmaps/`（169 个 .bcmap）—— CJK 等非标准编码的字符映射。**缺了中文 PDF
 *     会渲染成空白**，而本仓库的使用场景以中文技术文档为主，这条必踩。
 *   - `standard_fonts/`（16 个）—— PDF 标准 14 字体的回退。
 *   - worker 由 Vite 以 `?url` 处理（见 `PdfRenderer.tsx`），不在这里复制。
 *
 * 复制到 `apps/desktop/renderer/public/pdfjs/`，因为 Vite 会把 `public/` 原样
 * 拷进产物根目录 —— 于是 dev（`http://localhost:6200`）与打包后
 * （`file:///.../out/renderer/index.html`）两种情形下，`./pdfjs/cmaps/` 都成立。
 * spike 已验证 `file://` 页面在 `connect-src 'self'` 下能取到这些 .bcmap。
 *
 * **产物目录被 gitignore**：185 个二进制文件（约 1.5MB）进版本库只会污染 diff，
 * 而它们完全可以从依赖里重建。代价是「直接跑 electron-vite build 而不走
 * pnpm 脚本」会漏掉这一步 —— 所以它挂在 `predev` / `prebuild` 上。
 *
 * 幂等：版本号写进 `.version` 标记文件，一致就整体跳过（避免每次构建都重写 185 个文件，
 * 那会拖慢构建并让文件时间戳全部变化）。
 *
 * **刻意不删任何东西**：版本变化时用 `fs.cp` 覆盖合并，而不是先清空目标目录 ——
 * 本机的 safe-delete 守卫按「每个对话请求 50 次」记账，构建期删目录会被直接拦下
 * （详见 `.workbuddy-ai/memory/windows-env-traps.md`）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// 解析基准必须是**声明 pdfjs-dist 的那个 package**，不能是脚本自己所在的 scripts/。
// pnpm 是严格布局：根 node_modules 只放根 package.json 的依赖，apps/desktop 的依赖
// 只出现在 apps/desktop/node_modules。用 createRequire(import.meta.url) 会一路往上找到
// 根 node_modules 而解析失败（表现为「找不到 pdfjs-dist」，但依赖明明装了）。
const DESKTOP_ROOT = path.join(REPO_ROOT, 'apps', 'desktop');
const require = createRequire(path.join(DESKTOP_ROOT, 'package.json'));

const DEST_ROOT = path.join(DESKTOP_ROOT, 'renderer', 'public', 'pdfjs');
const VERSION_STAMP = path.join(DEST_ROOT, '.version');

/** 需要复制的子目录（相对 pdfjs-dist 包根）。worker 不在这里。 */
const ASSET_DIRS = ['cmaps', 'standard_fonts'];

function resolvePdfjsRoot() {
  try {
    // 用 require.resolve 而不是硬拼 node_modules 路径：pnpm 的布局是符号链接，
    // 硬拼出来的路径在别的机器上未必成立。
    return path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch {
    return null;
  }
}

async function readStamp() {
  try {
    return (await fs.readFile(VERSION_STAMP, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function main() {
  const pdfjsRoot = resolvePdfjsRoot();
  if (!pdfjsRoot) {
    console.error(
      '[copy-pdfjs-assets] 找不到 pdfjs-dist。先安装依赖（pnpm install），或检查 apps/desktop 的依赖声明。'
    );
    process.exitCode = 1;
    return;
  }

  const version = JSON.parse(await fs.readFile(path.join(pdfjsRoot, 'package.json'), 'utf8')).version;
  const stamp = await readStamp();

  if (stamp === version) {
    console.log(`[copy-pdfjs-assets] pdfjs-dist@${version} 的资源已就位，跳过。`);
    return;
  }

  let copied = 0;
  for (const dir of ASSET_DIRS) {
    const from = path.join(pdfjsRoot, dir);
    const to = path.join(DEST_ROOT, dir);
    await fs.mkdir(to, { recursive: true });
    // force: true → 已存在则覆盖；recursive: true → 建目录。
    // 不先清空目标目录，避免触发 safe-delete 的批量删除守卫。
    await fs.cp(from, to, { recursive: true, force: true });
    copied += (await fs.readdir(to)).length;
  }

  await fs.writeFile(VERSION_STAMP, `${version}\n`, 'utf8');
  console.log(
    `[copy-pdfjs-assets] pdfjs-dist@${version} → apps/desktop/renderer/public/pdfjs/（${copied} 项）`
  );
}

await main();
