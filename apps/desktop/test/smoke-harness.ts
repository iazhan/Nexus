import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 单字符 → US 布局 KeyboardEvent.code。
 * 只用于事件的 code 字段（不影响插入文本），让 CDP 事件更接近真实键盘。
 */
const PUNCTUATION_CODES: Record<string, string> = {
  '`': 'Backquote',
  '~': 'Backquote',
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash'
};

function charToCode(key: string): string {
  if (key >= 'a' && key <= 'z') return `Key${key.toUpperCase()}`;
  if (key >= 'A' && key <= 'Z') return `Key${key}`;
  if (key >= '0' && key <= '9') return `Digit${key}`;
  return PUNCTUATION_CODES[key] ?? `Key${key.toUpperCase()}`;
}

/**
 * 读文件内容，容忍「目标暂时不存在」。
 *
 * Windows 下 `atomicWriteFile` 是「目标 → 备份 → 临时 → 目标」三步替换（避开 Node rename
 * 在目标被占用时的 EPERM），中间存在目标文件**不存在**的窗口。轮询等落盘时裸
 * `readFileSync` 会偶发 ENOENT —— 那不是"没写成功"，只是读到了中间态。
 * 返回 `null` 表示此刻读不到，调用方继续轮询即可。
 */
export function readFileTolerant(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function getFreePort(): Promise<number> {  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 9333;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function resolveElectronBinary(): string {
  // 1. Try resolving electron from apps/desktop/node_modules/electron
  const electronPkgPath = path.resolve(__dirname, '../node_modules/electron');
  const pathTxt = path.join(electronPkgPath, 'path.txt');
  if (fs.existsSync(pathTxt)) {
    const exeName = fs.readFileSync(pathTxt, 'utf-8').trim();
    const exePath = path.join(electronPkgPath, 'dist', exeName);
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  // 2. Try root node_modules
  const rootElectronPkg = path.resolve(__dirname, '../../../node_modules/electron');
  const rootPathTxt = path.join(rootElectronPkg, 'path.txt');
  if (fs.existsSync(rootPathTxt)) {
    const exeName = fs.readFileSync(rootPathTxt, 'utf-8').trim();
    const exePath = path.join(rootElectronPkg, 'dist', exeName);
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  // Fallback to 'electron' on PATH
  return process.platform === 'win32' ? 'electron.cmd' : 'electron';
}

export interface LaunchElectronOptions {
  filePath?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * 等「索引跑完并渲染出文件树」的上限。
 *
 * 这是一次**很重的**等待：Electron 启动 → 侧栏挂载 → `rebuildIndex()`（扫盘 + 写 SQLite）
 * → `listIndexedDocuments()` → 渲染。空载约 2–3 秒，机器忙时会明显更久。
 *
 * 需要它的用例一律用这个常量，不再各写字面量 —— 之前散落着 30s / 60s / 120s 三种值，
 * 而 `it` 的超时还必须大于它，手工同步迟早写错。
 */
export const INDEX_WAIT_MS = 60_000;

/**
 * 需要等索引的用例的超时。
 *
 * **必须大于 `INDEX_WAIT_MS`** —— 否则外层先炸、内层永远等不到，
 * 而报错会指向外层超时，看不出真正卡在哪一步。
 * 写成加法而不是字面量，就是为了让这个关系不可能被写反。
 */
export const INDEXED_TEST_TIMEOUT_MS = INDEX_WAIT_MS + 60_000;

export class ElectronAppInstance {
  public readonly proc: ChildProcess;
  public readonly port: number;
  public readonly target: CDPTarget;
  /** 本实例专属的 userData 目录；`close()` 时删掉，避免临时目录无限累积。 */
  public readonly userDataDir: string;
  private ws: WebSocket;
  private msgId = 0;
  private readonly pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(
    proc: ChildProcess,
    port: number,
    target: CDPTarget,
    ws: WebSocket,
    userDataDir: string
  ) {
    this.proc = proc;
    this.port = port;
    this.target = target;
    this.ws = ws;
    this.userDataDir = userDataDir;

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        if (data.method === 'Runtime.consoleAPICalled') {
          console.log('[Renderer CONSOLE]', data.params.type, data.params.args?.map((a: any) => a.value || a.description).join(' '));
        }
        if (data.method === 'Runtime.exceptionThrown') {
          console.error('[Renderer EXCEPTION]', data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
        }
        if (typeof data.id === 'number' && this.pendingRequests.has(data.id)) {
          const { resolve, reject } = this.pendingRequests.get(data.id)!;
          this.pendingRequests.delete(data.id);
          if (data.error) {
            reject(new Error(`CDP Error: ${data.error.message || JSON.stringify(data.error)}`));
          } else {
            resolve(data.result);
          }
        }
      } catch (err) {
        console.error('[CDP] Message parse error:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[CDP] WebSocket error:', err);
    };
  }

  public sendCommand<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  public async evaluate<T = any>(expression: string): Promise<T> {
    const res = await this.sendCommand<{
      result: { type: string; value?: any; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Evaluation exception: ${desc}`);
    }

    return res.result.value as T;
  }

  public async waitForSelector(selector: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        if (found) return;
      } catch {
        // ignore evaluate error during loading
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const htmlObj = await this.sendCommand('Runtime.evaluate', { expression: 'document.body.innerHTML' });
    console.log('[HTML DUMP]', htmlObj.result?.value);

    throw new Error(`Timeout (${timeoutMs}ms) waiting for selector: ${selector}`);
  }

  /**
   * 轮询直到条件成立。
   *
   * 参数**同时接受两种写法**：
   *   - 函数：`() => document.querySelector('.x') !== null`
   *   - 表达式：`window.nexusSession.getSnapshot().source.includes('foo')`
   *
   * 早先只支持函数（拼成 `Boolean((expr)())`），传表达式时会变成对布尔值调用 `()`
   * → 抛错 → 被下面的 catch 吞掉 → 表现成「条件永远不成立」，排查起来非常绕。
   */
  public async waitForFunction(fnExpression: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.evaluate<boolean>(
          `(() => { const v = (${fnExpression}); return typeof v === 'function' ? Boolean(v()) : Boolean(v); })()`
        );
        if (ok) return;
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout (${timeoutMs}ms) waiting for function: ${fnExpression}`);
  }

  public async getText(selector: string): Promise<string> {
    await this.waitForSelector(selector);
    return await this.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  }

  public async click(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`);
  }

  public async mouseClick(selector: string, modifiers = 0): Promise<void> {
    await this.waitForSelector(selector);
    const rect = await this.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await this.mouseClickCoords(x, y, modifiers);
  }

  /**
   * `modifiers` 用 CDP 的位掩码：1=Alt、2=Ctrl、4=Meta、8=Shift。
   * 不传则与普通左键点击完全一致。
   */
  public async mouseClickCoords(x: number, y: number, modifiers = 0): Promise<void> {
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers
    });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers
    });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers
    });
  }

  public async pressKey(key: string, modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): Promise<void> {
    const isCtrl = Boolean(modifiers?.ctrl);
    const isShift = Boolean(modifiers?.shift);
    const isAlt = Boolean(modifiers?.alt);
    const isMeta = Boolean(modifiers?.meta);

    let modifierFlags = 0;
    if (isAlt) modifierFlags |= 1;
    if (isCtrl) modifierFlags |= 2;
    if (isMeta) modifierFlags |= 4;
    if (isShift) modifierFlags |= 8;

    let code = `Key${key.toUpperCase()}`;
    // 可打印单字符不设置 windowsVirtualKeyCode：
    // charCodeAt 会与 Windows VK 常量撞车（#=VK_END、(=VK_DOWN、.=VK_DELETE、-=VK_INSERT…），
    // 导致按键被 Chromium 当成控制键，字符丢失或光标错位。
    let windowsVirtualKeyCode: number | undefined;
    if (key === 'Enter') {
      code = 'Enter';
      windowsVirtualKeyCode = 13;
    } else if (key === 'Escape') {
      code = 'Escape';
      windowsVirtualKeyCode = 27;
    } else if (key === ' ') {
      code = 'Space';
      windowsVirtualKeyCode = 32;
    } else if (key === 'Tab') {
      code = 'Tab';
      windowsVirtualKeyCode = 9;
    } else if (key === 'Backspace') {
      code = 'Backspace';
      windowsVirtualKeyCode = 8;
    } else if (key.length === 1) {
      code = charToCode(key);
    }

    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      modifiers: modifierFlags,
      windowsVirtualKeyCode
    });

    if (key.length === 1 && !isCtrl && !isAlt && !isMeta) {
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'char',
        text: key,
        unmodifiedText: key,
        modifiers: modifierFlags
      });
    }

    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      modifiers: modifierFlags,
      windowsVirtualKeyCode
    });
  }

  public async insertText(text: string): Promise<void> {
    await this.sendCommand('Input.insertText', { text });
  }

  public async typeText(text: string): Promise<void> {
    for (const ch of text) {
      await this.pressKey(ch);
    }
  }

  /**
   * 等索引就绪（工作区文件树渲染出来）。
   *
   * 这是整套 desktop 测试里**最重的一次等待**：Electron 启动 → 侧栏挂载 →
   * `rebuildIndex()`（扫盘 + 写 SQLite）→ `listIndexedDocuments()` → 渲染。
   *
   * ## 为什么分两步等
   *
   * 先等侧栏容器（它立即出现），再等文件树。只等 `.nexus-tree-item` 的话，
   * 「侧栏没挂载」和「索引没跑完 / 索引失败」看起来完全一样，超时报错里什么都读不出来。
   * 分开等 + 失败时把 phase 和侧栏文案一起抛出来，一次就能定位。
   *
   * 调用方的 `it` 超时必须大于这里传的 `timeoutMs`，用 `INDEXED_TEST_TIMEOUT_MS`
   * 就不会写反 —— 它是 `INDEX_WAIT_MS + 60_000`，不是字面量。
   */
  public async waitForIndexReady(timeoutMs: number = INDEX_WAIT_MS): Promise<void> {
    await this.waitForSelector('.nexus-workspace-sidebar', 30_000);

    try {
      await this.waitForSelector('.nexus-tree-item', timeoutMs);
    } catch (err) {
      const phase = await this.evaluate<string>(
        `document.querySelector('.nexus-workspace-sidebar')?.dataset.phase ?? '(没有 phase 属性)'`
      );
      const text = await this.evaluate<string>(
        `document.querySelector('.nexus-workspace-sidebar')?.textContent ?? '(侧栏不存在)'`
      );

      throw new Error(
        `等索引就绪超时。phase=${phase} / 侧栏内容=${text} / 原始错误=${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  public async close(): Promise<void> {    try {
      try {
        this.ws.close();
      } catch {
        // ignore
      }

      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        return;
      }

      try {
        this.proc.kill('SIGTERM');
      } catch (err) {
        if (this.proc.exitCode === null) {
          throw err;
        }
        return;
      }

      await this.waitForExit(1000);
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        return;
      }

      try {
        this.proc.kill('SIGKILL');
      } catch (err) {
        if (this.proc.exitCode === null) {
          throw err;
        }
      }
      await this.waitForExit(1000);
    } finally {
      // 清理放在 finally：上面有三个提前 return 的分支，写在末尾会漏掉。
      // 必须等进程真的退出 —— Windows 上目录被占用时删不掉。
      // 删失败也不影响测试结果，它只是落在系统临时目录里。
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.proc.removeListener('exit', onExit);
        resolve();
      }, timeoutMs);
      this.proc.once('exit', onExit);
    });
  }
}

export async function launchElectronApp(options: LaunchElectronOptions = {}): Promise<ElectronAppInstance> {
  const electronExe = resolveElectronBinary();
  const mainScript = path.resolve(__dirname, '../out/main/index.cjs');
  const port = await getFreePort();

  if (!fs.existsSync(mainScript)) {
    throw new Error(`Desktop build output not found at ${mainScript}. Run 'pnpm --filter @nexus/desktop build' first.`);
  }

  const args: string[] = [
    '.',
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--no-sandbox',
    '--test-mode'
  ];

  // **每个实例用独立的 userData 目录**，跑完随临时目录一起删。
  //
  // 不这么做的话所有实例共用 `%APPDATA%/@nexus/desktop`，索引库（每个测试一个）
  // 和 Electron 的临时文件会无限累积 —— 实测累积到 271M / 128 个索引库。
  // 而累积本身会让后续实例启动变慢，表现为「全量跑到后半段，等文件树超时」
  // 这种看起来随机、单跑却总是通过的失败。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-userdata-'));
  args.push(`--user-data-dir=${userDataDir}`);

  if (options.filePath) {
    args.push(options.filePath);
  }
  if (options.args) {
    args.push(...options.args);
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const proc = spawn(electronExe, args, {
    cwd: options.cwd ?? path.resolve(__dirname, '..'),
    env: {
      ...childEnv,
      NODE_ENV: 'test',
      ...options.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stdout?.on('data', (d) => {
    console.log('[Electron STDOUT]', d.toString());
  });

  proc.stderr?.on('data', (d) => {
    const str = d.toString();
    if (str.includes('Error:') || str.includes('FATAL')) {
      console.error('[Electron STDERR]', str);
    }
  });

  const start = Date.now();
  let target: CDPTarget | null = null;
  while (Date.now() - start < 15000) {
    if (proc.killed || proc.exitCode !== null) {
      throw new Error(`Electron process exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (resp.ok) {
        const list: CDPTarget[] = (await resp.json()) as CDPTarget[];
        const found = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (found) {
          target = found;
          break;
        }
      }
    } catch {
      // connecting...
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!target) {
    proc.kill('SIGKILL');
    throw new Error(`Failed to connect to Electron CDP on port ${port} within 15s`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });

  const instance = new ElectronAppInstance(proc, port, target, ws, userDataDir);
  await instance.sendCommand('Runtime.enable');
  await instance.sendCommand('Page.enable');
  // 无边框窗口不保证拿到系统焦点，未激活时 CDP 输入事件会被丢弃；开启焦点模拟保证按键可达。
  await instance.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });

  return instance;
}
