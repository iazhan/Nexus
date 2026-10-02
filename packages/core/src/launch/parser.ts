import { DEFAULT_LAUNCH_CONTEXT, type LaunchContext } from '../types/mode.js';
import { documentTypeForPath } from '../document/extensions.js';

/**
 * Known Chromium, Electron, and Node.js CLI flags that expect a separate value argument
 * when not formatted with an inline '=' (e.g. '--user-data-dir /path' vs '--user-data-dir=/path').
 */
const DEFAULT_VALUE_FLAGS = new Set([
  '--user-data-dir',
  '--disk-cache-dir',
  '--crash-dumps-dir',
  '--log-file',
  '--profile-directory',
  '--window-size',
  '--window-position',
  '--proxy-server',
  '--proxy-bypass-list',
  '--proxy-pac-url',
  '--host-rules',
  '--auth-server-whitelist',
  '--auth-negotiate-delegate-whitelist',
  '--js-flags',
  '--inspect-port',
  '--remote-debugging-port',
  '-r',
  '--require',
  '-e',
  '--eval',
  '-p',
  '--print'
]);

/**
 * Pattern matching port specifications:
 * - Pure port numbers: e.g. '9229'
 * - Host and port combinations: e.g. '127.0.0.1:9229', 'localhost:9229', '[::1]:9229'
 */
const PORT_OR_HOST_PORT_PATTERN = /^(\d+|[\w.-]+:\d+|\[[\da-fA-F:]+\]:\d+)$/;

/**
 * Options for parsing launch arguments.
 */
export interface ParseLaunchArgsOptions {
  /**
   * Explicit path to the runtime executable to filter out (e.g. process.execPath).
   */
  execPath?: string;
  /**
   * Additional CLI flags that consume the subsequent argument as their value.
   */
  additionalValueFlags?: string[];
  /**
   * 判断一个非 Markdown 路径是目录还是文件，决定是否进入 workspace 模式。
   *
   * 由调用方注入（main 进程用 fs.statSync），本函数因此不碰文件系统、在单测里保持纯函数。
   * 不注入时非 Markdown 路径一律按「不支持的文件」处理 —— 这是与旧行为兼容的默认值。
   */
  classifyPath?: (targetPath: string) => 'directory' | 'file' | 'unknown';
}

/**
 * Normalizes a file or executable path for uniform comparison.
 */
function normalizePath(filePath: string): string {
  return filePath.trim().toLowerCase().replace(/\\/g, '/');
}

/**
 * Checks if a CLI argument matches runtime binaries (node, electron).
 */
function isRuntimeBinary(arg: string): boolean {
  const normalized = normalizePath(arg);
  const filename = normalized.split('/').pop() ?? '';
  return (
    filename === 'node' ||
    filename === 'node.exe' ||
    filename === 'electron' ||
    filename === 'electron.exe'
  );
}

/**
 * Checks if a CLI argument is an entry point script or project directory path in dev mode.
 */
function isEntryScriptOrCwd(arg: string): boolean {
  if (arg === '.' || arg === './' || arg === '.\\') {
    return true;
  }
  const normalized = normalizePath(arg);
  return (
    normalized.endsWith('/apps/desktop') ||
    normalized === 'apps/desktop' ||
    normalized.endsWith('/out/main/index.js') ||
    normalized.endsWith('/electron/index.ts') ||
    normalized.endsWith('/electron/main.ts')
  );
}

/**
 * Checks if an argument represents the application runtime binary or packaged executable.
 */
function isExecutableBinary(
  arg: string,
  index: number,
  options?: ParseLaunchArgsOptions
): boolean {
  const norm = normalizePath(arg);

  // 1. Explicit caller-provided execPath match
  if (options?.execPath && norm === normalizePath(options.execPath)) {
    return true;
  }

  // 2. Known runtime binary check
  if (isRuntimeBinary(arg)) {
    return true;
  }

  // 3. Leading process.argv[0] executable detection (Windows .exe, macOS bundle binary)
  if (index === 0) {
    if (norm.endsWith('.exe')) {
      return true;
    }
    if (norm.includes('.app/contents/macos/')) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a flag consumes the subsequent argument as a separate value.
 */
function consumesNextArgAsValue(
  flag: string,
  nextArg: string | undefined,
  valueFlagsSet: Set<string>
): boolean {
  // If the flag already contains an inline value (e.g. --flag=val), it does not consume the next arg
  if (flag.includes('=')) {
    return false;
  }

  // If there is no next argument or the next argument is another flag, it cannot be a value
  if (!nextArg || nextArg.startsWith('-')) {
    return false;
  }

  // Standard value flags (e.g. --user-data-dir <path>)
  if (valueFlagsSet.has(flag.toLowerCase())) {
    return true;
  }

  // Node inspect flags (--inspect, --inspect-brk) take an optional [host:]port argument
  const lowerFlag = flag.toLowerCase();
  if (lowerFlag === '--inspect' || lowerFlag === '--inspect-brk') {
    return PORT_OR_HOST_PORT_PATTERN.test(nextArg);
  }

  return false;
}

// 扩展名判定已移到 `../document/extensions.js`（`getPathExtension` / `documentTypeForPath`）。
// 白名单必须只有一处 —— 否则 main 侧（FileService）与启动解析会各判一份，
// 而「同一个问题在两处各答一遍」是本仓库已经踩过的坑（mermaid 判定曾散在四处）。

/**
 * Parses command-line arguments into a LaunchContext.
 *
 * Rules:
 * 1. Runtime binaries (node, electron) and packaged executables (argv[0] or execPath) are skipped.
 * 2. Dev entry points ('.', 'apps/desktop', etc.) are skipped.
 * 3. CLI flags starting with '-' are skipped.
 * 4. Flags expecting a separate value (e.g. '--user-data-dir <dir>', '--inspect <port>') consume and skip their value argument.
 * 5. The first candidate non-flag argument is evaluated against the document whitelist
 *    (`../document/extensions.js`):
 *    - Markdown (.md, .markdown) → mode 'lightweight' with filePath set.
 *    - PDF / DOCX / image → mode 'viewer' with filePath + documentType set (Phase 3).
 *    - Otherwise the optional `classifyPath` callback decides:
 *        'directory' → mode 'workspace' with workspaceRoot set;
 *        'file' / 'unknown' / callback absent → mode 'lightweight' with unsupportedPath set.
 * 6. If no candidate argument is found, returns `DEFAULT_LAUNCH_CONTEXT` —— 裸启动，
 *    也就是工作区模式（目录由启动回落补，见 `applyRecentWorkspace`）。
 *
 * @param argv - The argument vector (e.g. process.argv or slice thereof)
 * @param options - Optional configuration including explicit execPath and additional value flags
 * @returns A serializable LaunchContext object
 */
export function parseLaunchArgs(
  argv: string[],
  options?: ParseLaunchArgsOptions
): LaunchContext {
  if (!argv || argv.length === 0) {
    return { ...DEFAULT_LAUNCH_CONTEXT };
  }

  // Construct effective value flags set
  const valueFlags = new Set(DEFAULT_VALUE_FLAGS);
  if (options?.additionalValueFlags) {
    for (const flag of options.additionalValueFlags) {
      valueFlags.add(flag.toLowerCase());
    }
  }

  const candidateArgs: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const rawArg = argv[i];
    if (!rawArg || typeof rawArg !== 'string') {
      i++;
      continue;
    }

    const trimmed = rawArg.trim();
    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Skip executable binaries and dev entry scripts
    if (isExecutableBinary(trimmed, i, options) || isEntryScriptOrCwd(trimmed)) {
      i++;
      continue;
    }

    // Check for CLI flags
    if (trimmed.startsWith('-')) {
      const nextArg = argv[i + 1]?.trim();
      if (consumesNextArgAsValue(trimmed, nextArg, valueFlags)) {
        // Skip both the flag and its separate value argument
        i += 2;
        continue;
      }
      // Boolean or self-contained flag, skip just this flag
      i++;
      continue;
    }

    // Argument is a candidate user path
    candidateArgs.push(trimmed);
    i++;
  }

  if (candidateArgs.length === 0) {
    return { ...DEFAULT_LAUNCH_CONTEXT };
  }

  const targetPath = candidateArgs[0]!;
  const documentType = documentTypeForPath(targetPath);

  if (documentType === 'markdown') {
    return {
      mode: 'lightweight',
      filePath: targetPath,
      documentType,
      workspaceRoot: null,
      unsupportedPath: null
    };
  }

  // 白名单里的非 Markdown 文档 → Viewer 模式（Phase 3 Document Center）。
  // 判定顺序是先白名单、后 classifyPath：反过来会把 `notes.pdf` 这种真实存在的文件
  // 交给 classifyPath，而它只回答「目录还是文件」，答不出文档类型。
  if (documentType) {
    return {
      mode: 'viewer',
      filePath: targetPath,
      documentType,
      workspaceRoot: null,
      unsupportedPath: null
    };
  }

  // 不在白名单：可能是工作区目录，也可能是不支持的文件。
  // 判定由调用方注入 —— 本函数不碰文件系统，才能在单测里保持纯函数。
  if (options?.classifyPath?.(targetPath) === 'directory') {
    return {
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: targetPath,
      unsupportedPath: null
    };
  }

  // 打不开的路径**不能**跟着默认值变成 workspace：那会让「双击一个 .xyz 文件」
  // 表现成「打开了一个工作区」，而用户需要看到的是那句「不支持的文件」。
  // 所以这一支显式写 `lightweight`，与「什么都没给」区分开。
  return {
    mode: 'lightweight',
    filePath: null,
    documentType: null,
    workspaceRoot: null,
    unsupportedPath: targetPath
  };
}
