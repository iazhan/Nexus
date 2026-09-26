// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  launchElectronApp,
  createTempDir,
  type ElectronAppInstance
} from './smoke-harness.js';

/**
 * workspace 模式的启动契约（P2-01）。
 *
 * 目录参数以前会被判成「不支持的文件」：`nexus.exe "D:\Notes"` 显示「只支持 Markdown 文档」。
 * 现在 main 进程用 fs.statSync 判定目录，parser 返回 mode: 'workspace' + workspaceRoot。
 *
 * 文件树与索引还没接入，所以这一条只验证「目录被正确识别」，以及**没有**被伪装成空编辑器 ——
 * 后者才是真风险：workspace 模式下渲染一个空白 `.cm-content`，用户会以为工作区里的文件是空的。
 */
describe('workspace 模式启动', () => {
  let tempDir: string;
  let activeApp: ElectronAppInstance | null = null;

  beforeAll(() => {
    tempDir = createTempDir('nexus-workspace-');
    fs.writeFileSync(path.join(tempDir, 'note.md'), '# 笔记\n\n正文。\n', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (activeApp) {
      await activeApp.close();
      activeApp = null;
    }
  });

  it('以目录为参数启动时进入 workspace 模式，且不伪造空编辑器', async () => {
    activeApp = await launchElectronApp({ filePath: tempDir });
    const app = activeApp;

    await app.waitForSelector('.nexus-workspace-empty', 20000);

    const shownPath = await app.evaluate<string>(
      `document.querySelector('.nexus-workspace-empty-path')?.textContent ?? ''`
    );
    expect(shownPath).toBe(tempDir);

    // 关键负向断言：不能同时渲染编辑器。
    const editorCount = await app.evaluate<number>(
      `document.querySelectorAll('.cm-content').length`
    );
    expect(editorCount).toBe(0);

    // 顶栏显示工作区目录名，而不是 Untitled.md
    const headerName = await app.evaluate<string>(
      `document.querySelector('.nexus-filename')?.textContent ?? ''`
    );
    expect(headerName).toBe(path.basename(tempDir));

    // 状态栏格式指标从 Markdown 切到 Workspace
    const format = await app.evaluate<string>(
      `document.querySelector('.status-format')?.textContent?.trim() ?? ''`
    );
    expect(format).toBe('Workspace');
  });

  it('路径不存在时仍按不支持处理，不会进入 workspace', async () => {
    // 打错一个字不该从「文件不存在」变成「打开一个空工作区」——
    // 那会把真实错误吞掉。main 的 classifyLaunchPath 对 stat 失败返回 'unknown'。
    const missing = path.join(tempDir, 'does-not-exist');

    activeApp = await launchElectronApp({ filePath: missing });
    const app = activeApp;

    await app.waitForSelector('.nexus-error-card', 20000);

    const workspaceCount = await app.evaluate<number>(
      `document.querySelectorAll('.nexus-workspace-empty').length`
    );
    expect(workspaceCount).toBe(0);
  });
});
