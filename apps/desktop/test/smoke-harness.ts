import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CDP_COMMAND_TIMEOUT_MS = 15000;

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
  /**
   * 复用某个 userData 目录，而不是每次新建一个临时目录。
   *
   * 默认行为（每个实例一个新目录）是为了隔离：不隔离的话索引库与 Electron 的临时文件会
   * 无限累积，累积本身又会让后续实例变慢。**只有「要跨两次启动验证同一份落盘状态」的用例
   * 才该传它** —— 目前只有「启动时恢复上次工作区」这一条：它的效果就是「上一次启动写了什么，
   * 下一次启动读到什么」，两次启动必须看同一个目录。
   *
   * 传进来的目录同样登记进 `createTempDir` 的清理表（用 `createTempDir` 造它即可），
   * 所以用例不必自己删。
   */
  userDataDir?: string;
}

export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * 页面 URL 里的窗口角色标记，与主进程的 `WINDOW_ROLE_PARAM` 同源。
 *
 * 判据取 **URL** 而不是 `<title>`：两个窗口的标题都会被渲染进程按语言写成同一个值，
 * 拿标题区分不开。主窗口也**显式**带 `window=main`，所以两条子串互不包含、不会误配。
 */
export const MAIN_WINDOW_URL_MARKER = 'window=main';
export const SETTINGS_WINDOW_URL_MARKER = 'window=settings';
export const THEME_WINDOW_URL_MARKER = 'window=theme';

/**
 * 测试用的临时目录登记表。
 *
 * 直接 `fs.mkdtempSync` 的话很容易忘了删 —— 实测有 14 个测试文件从没清理过，
 * `%TEMP%` 里积了 1400 个 `nexus-whitescreen-*`。而目录一多，
 * `mkdtempSync` 本身就变慢，全量耗时会跟着涨。
 *
 * 所以统一走 `createTempDir()`，退出时一起删。
 */
const tempDirs = new Set<string>();

/**
 * 测试临时目录的前缀。
 *
 * 这不只是命名习惯：`sweepStaleTempDirs()` 靠它认出「这是我们的残留」。
 * `createTempDir` 会校验前缀，别绕过它。
 */
export const TEMP_DIR_PREFIX = 'nexus-';

process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 进程退出阶段删不掉不影响测试结果，别在这里抛
    }
  }
  tempDirs.clear();
});

/**
 * 陈旧阈值：24 小时。
 *
 * 一次全量真机跑也就几十分钟，所以超过一天的 `nexus-*` 目录只可能来自被强杀的旧进程。
 * 不能再压小 —— 压到分钟级就得论证「并行跑的另一批会不会刚好卡在边界上」，
 * 而那件事没法证明。
 */
const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 清掉 `%TEMP%` 里超过 `STALE_TEMP_DIR_AGE_MS` 的 `nexus-*` 残留目录，返回清掉的个数。
 *
 * 上面那个 `process.on('exit')` 只覆盖**正常退出**：批跑超时被 SIGTERM、或者手工
 * `taskkill //F //IM electron.exe` 之后它根本不跑，那一批建的目录就永远留下了
 * （实测攒到过 275 个 / 54.7 MB，而目录一多 `mkdtempSync` 本身也会变慢）。
 * 所以每次跑测试先收一次昨天的账。
 *
 * 三条边界都是「宁可少删」：只删目录（`mkdtempSync` 只造目录）、只删前缀匹配的、
 * 只删够旧的。够旧这条同时保证了并行跑的其他测试文件不受影响 —— 它们手里的目录
 * 才几秒钟新。任何失败都吞掉：清理失败不该让测试变红。
 */
export function sweepStaleTempDirs(): number {
  const root = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // 读不到临时目录（沙箱、权限）就什么都不做
  }

  const cutoff = Date.now() - STALE_TEMP_DIR_AGE_MS;
  let swept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    if (tempDirs.has(dir)) continue; // 本进程自己建的，一定不删
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      swept++;
    } catch {
      // 删不掉（仍被占用、权限）就跳过，留给下一轮
    }
  }
  return swept;
}

/**
 * 建一个测试用的临时目录，退出时自动清理。
 *
 * 用它替代裸的 `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`。
 * 前缀必须以 `TEMP_DIR_PREFIX` 开头，否则被强杀留下的目录没人收。
 */
export function createTempDir(prefix: string): string {
  if (!prefix.startsWith(TEMP_DIR_PREFIX)) {
    throw new Error(
      `createTempDir 的前缀必须以 "${TEMP_DIR_PREFIX}" 开头（收到 "${prefix}"），` +
        '否则它不在 sweepStaleTempDirs 的清扫范围内'
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * 等 Electron 起来并把 CDP 调试端口就绪的上限。
 *
 * 这个等待**不受 vitest 的 testTimeout 约束** —— 它在 `launchElectronApp` 内部，
 * 超时后直接抛错，用例连第一行都跑不到。
 *
 * 45s 而不是 15s：全量跑到后半段时机器已经被前面几十个 Electron 实例拖慢，
 * 实测出现过 `Failed to connect to Electron CDP within 15s` 的偶发失败。
 * 启动 + CDP 就绪在空载时约 2–3 秒，但满载时能到 20 秒以上。
 */
export const CDP_CONNECT_TIMEOUT_MS = 45_000;

/**
 * WebSocket 握手超时。
 *
 * 与 `CDP_CONNECT_TIMEOUT_MS` 同源：CDP 端口就绪之后还要建 WebSocket，
 * 机器满载时这一步也会慢。原值 5s 太紧。
 */
export const WS_CONNECT_TIMEOUT_MS = 15_000;

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
  /** 当前附着的那一页。多窗口时由 `attachToWindow()` 换掉 —— 所以不是 `readonly`。 */
  public target: CDPTarget;
  /** 本实例专属的 userData 目录；`close()` 时删掉，避免临时目录无限累积。 */
  public readonly userDataDir: string;
  /**
   * 这个目录是本实例建的吗。**`false` 时 `close()` 不删它** —— 调用方传了
   * `userDataDir` 就说明他要跨启动复用同一份状态，删掉等于把第二次启动的数据抹了。
   * 复用目录的清理归 `createTempDir` 的退出钩子。
   */
  private readonly ownsUserDataDir: boolean;
  private ws: WebSocket;
  private msgId = 0;
  private readonly pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(
    proc: ChildProcess,
    port: number,
    target: CDPTarget,
    ws: WebSocket,
    userDataDir: string,
    ownsUserDataDir = true
  ) {
    this.proc = proc;
    this.port = port;
    this.target = target;
    this.ws = ws;
    this.userDataDir = userDataDir;
    this.ownsUserDataDir = ownsUserDataDir;
    this.bindSocket(ws);
  }

  /**
   * 把消息/错误处理挂到一条 WebSocket 上。
   *
   * 抽出来是因为 `attachToWindow()` 会换一条连接 —— 换连接时忘了重新绑定，
   * 症状是「切过去之后每个命令都超时」，而 WebSocket 本身是通的。
   */
  private bindSocket(ws: WebSocket): void {
    ws.onmessage = (event) => {
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

    ws.onerror = (err) => {
      console.error('[CDP] WebSocket error:', err);
    };
  }

  /** 当前所有可调试的页面。多窗口时用它数窗口、找目标。 */
  public async pageTargets(): Promise<CDPTarget[]> {
    const resp = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!resp.ok) return [];
    const list = (await resp.json()) as CDPTarget[];
    return list.filter((t) => t.type === 'page' && Boolean(t.webSocketDebuggerUrl));
  }

  /**
   * 等 URL 里含 `match` 的页面数量到达 `expected`。
   *
   * 判据取 **URL 片段**而不是标题：两个窗口的 `<title>` 都会被渲染进程按语言写成同一个值，
   * 拿标题区分不开。设置窗口靠 `?window=settings` 认（主进程 `WINDOW_ROLE_QUERY`）。
   */
  public async waitForPageCount(match: string, expected: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < timeoutMs) {
      try {
        last = (await this.pageTargets()).filter((t) => t.url.includes(match)).length;
        if (last === expected) return;
      } catch {
        // 端口偶尔抽风，继续等
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
      `Timeout (${timeoutMs}ms) waiting for ${expected} page(s) matching ${JSON.stringify(match)}; saw ${last}`
    );
  }

  /**
   * 向页面派发一次 `keydown`，**不走 CDP 的输入管线**。
   *
   * `pressKey()` 用 `Input.dispatchKeyEvent`，它依赖窗口真实持有系统焦点 —— 无头 / 后台运行时
   * 不可靠：实测**命令不返回**，15s 后以 `CDP command timed out after 15000ms: Input.dispatchKeyEvent`
   * 失败（`quick-open.test.ts` 的文件头也记过同一件事）。设置窗口建出来时会抢焦点，
   * 之后主窗口上的按键就再也派不出去了。
   *
   * 这里直接构造 `KeyboardEvent` 派发到 `window`：测的是**同一段 keydown 处理逻辑**，
   * 只是绕开了操作系统的焦点条件。差别是拿不到浏览器原生默认行为（Ctrl+P 不会真的触发打印），
   * 而我们测的是应用自己挂的监听器，所以不影响。
   *
   * 需要真实按键路径的用例（lightweight 模式下那几个）继续用 `pressKey()`。
   */
  public async dispatchKey(
    key: string,
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
  ): Promise<void> {
    await this.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        ctrlKey: ${Boolean(modifiers?.ctrl)},
        shiftKey: ${Boolean(modifiers?.shift)},
        altKey: ${Boolean(modifiers?.alt)},
        metaKey: ${Boolean(modifiers?.meta)},
        bubbles: true,
        cancelable: true
      }));
      return true;
    })()`);
  }

  /**
   * 切到另一个页面（多窗口）。
   *
   * 握手步骤与 `launchElectronApp` 里那段**必须一致**，`Emulation.setFocusEmulationEnabled`
   * 尤其不能省：无边框窗口不保证拿到系统焦点，未激活时 `Input.dispatchKeyEvent` 会被丢弃
   * （症状是「切过去之后按键没反应」，而点击正常）。
   *
   * ## 多窗口下的一条硬约束（2026-09-29 实测）
   *
   * **只有「持有操作系统焦点」的那个窗口能收到 CDP 输入事件。** 设置窗口建出来时会
   * `win.focus()`，此后主窗口的 `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`
   * 都会**不返回**，15s 后以 CDP 超时失败。（`evaluate` 不受影响：它走 JS 执行，不经过输入管线。）
   *
   * 所以多窗口用例：需要键盘时用 `dispatchKey()`（DOM 派发），需要点击时只对当前聚焦的
   * 那个窗口点，或者干脆用 `evaluate` 直接调桥。
   */
  public async attachToWindow(match: string, timeoutMs = CDP_CONNECT_TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    let found: CDPTarget | null = null;
    while (Date.now() - start < timeoutMs) {
      try {
        found = (await this.pageTargets()).find((t) => t.url.includes(match)) ?? null;
        if (found) break;
      } catch {
        // 还在起
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!found) {
      throw new Error(
        `No CDP page target matching ${JSON.stringify(match)} within ${timeoutMs}ms`
      );
    }

    try {
      this.ws.close();
    } catch {
      // 旧连接关不掉不影响新连接
    }
    // 旧连接上的未决请求永远不会回来了，留着只会让它们各自超时。
    this.pendingRequests.clear();

    const ws = new WebSocket(found.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WebSocket connection timeout (${WS_CONNECT_TIMEOUT_MS / 1000}s)`)),
        WS_CONNECT_TIMEOUT_MS
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });

    this.ws = ws;
    this.target = found;
    this.bindSocket(ws);

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Page.enable');
    await this.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  public sendCommand<T = any>(
    method: string,
    params: Record<string, any> = {},
    timeoutMs = CDP_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
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
    let lastEvaluationError: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        if (found) return;
      } catch (error) {
        lastEvaluationError = error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const htmlObj = await this.sendCommand('Runtime.evaluate', { expression: 'document.body.innerHTML' });
    console.log('[HTML DUMP]', htmlObj.result?.value);

    const detail = lastEvaluationError instanceof Error ? ` Last evaluation error: ${lastEvaluationError.message}` : '';
    throw new Error(`Timeout (${timeoutMs}ms) waiting for selector: ${selector}.${detail}`);
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
    let lastEvaluationError: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.evaluate<boolean>(
          `(() => { const v = (${fnExpression}); return typeof v === 'function' ? Boolean(v()) : Boolean(v); })()`
        );
        if (ok) return;
      } catch (error) {
        lastEvaluationError = error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const detail = lastEvaluationError instanceof Error ? ` Last evaluation error: ${lastEvaluationError.message}` : '';
    throw new Error(`Timeout (${timeoutMs}ms) waiting for function: ${fnExpression}.${detail}`);
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

  /**
   * 派发一次滚轮。`deltaY` 正数向下滚。
   *
   * 滚轮在 CDP 里是 `mouseWheel` 类型（不是 `mousePressed` 加个参数），增量走
   * `deltaX` / `deltaY`。**修饰键只认位掩码**：1=Alt、2=Ctrl、4=Meta、8=Shift ——
   * 应用里的「Ctrl+滚轮缩放」要靠它，用键盘事件是模拟不出来的。
   */
  public async mouseWheelCoords(
    x: number,
    y: number,
    deltaY: number,
    modifiers = 0
  ): Promise<void> {
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
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

  /**
   * 把编辑器内容整篇换成给定源码，光标回到开头并聚焦。
   *
   * ## 为什么用 dispatch 而不是模拟按键
   *
   * 要验的是**渲染结果**，不是键盘输入。一次事务替换整篇，比逐字敲快几个数量级，
   * 而且不依赖输入法、窗口焦点、光标初始位置这些与断言无关的东西。
   * 链路没有打折：仍然走 dispatch → 事务 → 装饰重算 → widget 渲染。
   *
   * 逐字输入本身另有专门的用例（visual-typing-smoke、autosave-caret-stability），
   * 那两条验的就是输入过程，不该用这个方法替代。
   *
   * 光标重置到开头是必须的：CM 会把光标夹到新文档长度内，停在末尾的话，
   * 依赖 `visualFocusField` 的 reveal 行为会和预期不同。
   */
  public async setSource(source: string): Promise<void> {
    await this.evaluate(`(() => {
      const view = window.nexusActiveView;
      if (!view) throw new Error('window.nexusActiveView 不存在');

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(source)} },
        selection: { anchor: 0, head: 0 }
      });
      view.focus();
      return true;
    })()`);

    // 等事务真正应用 —— 轮询文档长度，比固定 sleep 快也稳。
    // 用长度而不是内容比对：这里只需要确认「事务已落地」，内容由断言去管。
    await this.waitForFunction(
      `() => window.nexusActiveView?.state.doc.length === ${source.length}`,
      10000
    );

    // 再等 CM 重新测量。
    //
    // 长度对**不等于**测量完成：`lineBlockAt()` / `scrollSnapshot()` 要等下一次测量才准，
    // 立刻读会拿到 0（表现为「滚到某一行之后 scrollTop 还是 0」）。
    // 依赖几何的用例（点击命中、滚动位置）在这一拍之前跑就会偶发失败。
    //
    // 原来每个用例都是「启动前把文件写好」，CM 启动时就测量完了，所以没暴露这个问题；
    // 改成运行时换源码之后必须有这一步。
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  /**
   * **优雅**关闭：先让渲染进程 `window.close()`，等它退干净，再走 `close()` 兜底。
   *
   * ## 什么时候必须用它
   *
   * 当用例要验的是「**磁盘上留下了什么**」，而那份状态由 Chromium 自己刷盘时 ——
   * 典型是 `localStorage`。`close()` 发的是 SIGTERM，在 Windows 上等于直接终止进程，
   * Chromium 的关闭清理（把 Local Storage 的 leveldb 提交掉）根本不会跑。
   *
   * 症状很隐蔽：**同一个进程内读得回来**（走的是内存），下一次启动读回来是空的 ——
   * 于是「跨启动持久化」这类用例会失败，而失败原因看起来像产品 bug。
   * 实测（2026-10-02）：`localStorage.setItem` 之后 SIGTERM，下次启动 `getItem` 返回 null；
   * 换成 `window.close()` + 等一拍之后，值正常读回，userData 里也多出
   * `Local State` / `Preferences` / `Session Storage` 这些只有优雅退出才会写的文件。
   *
   * 代价是慢一点（多等一拍），所以**默认的 `close()` 不改成这个** ——
   * 绝大多数用例不关心磁盘状态。
   */
  public async closeGracefully(settleMs = 1500): Promise<void> {
    try {
      await this.evaluate(`window.close()`);
    } catch {
      // 窗口已经关了，evaluate 会失败 —— 那正是我们要的结果
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    await this.close();
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
      //
      // 用**异步 + 限时**而不是 `rmSync`：Windows 上删 Electron 的 userData 目录
      // （GPUCache / Local Storage / Network 这些）在机器重负载时会卡很久，而
      // `rmSync` 会直接阻塞事件循环 —— 实测把 `afterEach` 拖过 60s 的 `hookTimeout`，
      // 表现为「visual-typing-smoke 偶发 hook 超时」，而单跑同一个文件 19/19 全绿。
      //
      // 限时 5s 之后不再等：这个目录已经登记在 `createTempDir` 的退出钩子里，
      // 测试进程退出时会兜住，所以放弃等待不会造成泄漏。
      await this.removeUserDataDir();
    }
  }

  /** 尽力删除本实例的 userData 目录；删不掉、或者太慢，都不阻塞用例。 */
  private async removeUserDataDir(): Promise<void> {
    // 复用别人给的目录时不删：那份状态是下一个实例要读的（见 `ownsUserDataDir`）。
    if (!this.ownsUserDataDir) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fs.promises.rm(this.userDataDir, { recursive: true, force: true }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        })
      ]);
    } catch {
      // 删不掉不影响测试结果，退出钩子会再兜一次
    } finally {
      // 定时器必须显式清掉：`Promise.race` 的败者不会自己消失，
      // 每个用例留一个 5s 的悬空 timer 会让事件循环多转好几圈。
      if (timer) clearTimeout(timer);
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
  //
  // 走 `createTempDir` 登记而不是裸 `mkdtempSync`：裸调用只在 `close()` 里删，
  // 而用例超时被杀、Electron 崩溃这类路径走不到 `close()`，目录就留在 `%TEMP%` 了。
  // 登记之后，进程退出钩子兜住最后一道。
  const userDataDir = options.userDataDir ?? createTempDir('nexus-userdata-');
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
  while (Date.now() - start < CDP_CONNECT_TIMEOUT_MS) {
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
    throw new Error(
      `Failed to connect to Electron CDP on port ${port} within ${CDP_CONNECT_TIMEOUT_MS / 1000}s`
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WebSocket connection timeout (${WS_CONNECT_TIMEOUT_MS / 1000}s)`)),
      WS_CONNECT_TIMEOUT_MS
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });

  const instance = new ElectronAppInstance(
    proc,
    port,
    target,
    ws,
    userDataDir,
    options.userDataDir === undefined
  );
  await instance.sendCommand('Runtime.enable');
  await instance.sendCommand('Page.enable');
  // 无边框窗口不保证拿到系统焦点，未激活时 CDP 输入事件会被丢弃；开启焦点模拟保证按键可达。
  await instance.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });

  return instance;
}
