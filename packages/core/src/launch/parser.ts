import { DEFAULT_LAUNCH_CONTEXT, type LaunchContext } from '../types/mode.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

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

/**
 * Extracts the file extension (with leading dot) from a path, in lowercase.
 */
function getExtension(filePath: string): string {
  const filename = filePath.split(/[/\\]/).pop() ?? '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) {
    return '';
  }
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Parses command-line arguments into a LaunchContext.
 *
 * Rules:
 * 1. Runtime binaries (node, electron) and packaged executables (argv[0] or execPath) are skipped.
 * 2. Dev entry points ('.', 'apps/desktop', etc.) are skipped.
 * 3. CLI flags starting with '-' are skipped.
 * 4. Flags expecting a separate value (e.g. '--user-data-dir <dir>', '--inspect <port>') consume and skip their value argument.
 * 5. The first candidate non-flag argument is evaluated:
 *    - Markdown extension (.md, .markdown) → mode 'lightweight' with filePath set.
 *    - Otherwise the optional `classifyPath` callback decides:
 *        'directory' → mode 'workspace' with workspaceRoot set;
 *        'file' / 'unknown' / callback absent → mode 'lightweight' with unsupportedPath set.
 * 6. If no candidate argument is found, returns default empty lightweight context.
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
  const ext = getExtension(targetPath);

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return {
      mode: 'lightweight',
      filePath: targetPath,
      workspaceRoot: null,
      unsupportedPath: null
    };
  }

  // 非 Markdown 路径：可能是工作区目录，也可能是不支持的文件。
  // 判定由调用方注入 —— 本函数不碰文件系统，才能在单测里保持纯函数。
  if (options?.classifyPath?.(targetPath) === 'directory') {
    return {
      mode: 'workspace',
      filePath: null,
      workspaceRoot: targetPath,
      unsupportedPath: null
    };
  }

  return {
    mode: 'lightweight',
    filePath: null,
    workspaceRoot: null,
    unsupportedPath: targetPath
  };
}
