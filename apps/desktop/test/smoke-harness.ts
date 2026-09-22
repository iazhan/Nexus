import { spawn, type ChildProcess } from 'node:child_process';
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

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

export class ElectronAppInstance {
  public readonly proc: ChildProcess;
  public readonly port: number;
  public readonly target: CDPTarget;
  private ws: WebSocket;
  private msgId = 0;
  private readonly pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(proc: ChildProcess, port: number, target: CDPTarget, ws: WebSocket) {
    this.proc = proc;
    this.port = port;
    this.target = target;
    this.ws = ws;

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

  public async waitForFunction(fnExpression: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.evaluate<boolean>(`Boolean((${fnExpression})())`);
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

  public async mouseClick(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    const rect = await this.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
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

  public async close(): Promise<void> {
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

  const instance = new ElectronAppInstance(proc, port, target, ws);
  await instance.sendCommand('Runtime.enable');
  await instance.sendCommand('Page.enable');
  // 无边框窗口不保证拿到系统焦点，未激活时 CDP 输入事件会被丢弃；开启焦点模拟保证按键可达。
  await instance.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });

  return instance;
}
