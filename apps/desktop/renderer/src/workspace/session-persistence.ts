/**
 * 「上次开着的文档」的落盘与读回 —— 下次启动时把工作区里的标签页接回来。
 *
 * ## 存在这儿而不是主进程
 *
 * 主进程已经用 `recent-workspace.json` 把**工作区根**接回来了（`electron/recent-workspace.ts`），
 * 但「开着哪些文档」这件事整个住在渲染进程（`WorkspaceStore` 是纯渲染层），主进程
 * 一概不知道。所以这一份快照跟着数据的家住：`localStorage`。
 *
 * 与设置存档同一条理由：本机偏好走渲染进程的统一存储入口，不为它另造一套文件 +
 * IPC 通道。设置存档已经在用同一个池子，多一个键的边际成本是零。
 *
 * ## 存什么、不存什么
 *
 * 存**路径**，不存内容。内容在磁盘上（保存过的）—— 存内容等于造第二份事实源，
 * 而两份之间必然漂移（症状：恢复出来的文档与磁盘不一致，保存时静默覆盖）。
 * 未命名文档（`filePath === null`）不存：没有路径就无从恢复。
 *
 * ## 失败方向：**不恢复**
 *
 * 读不动、JSON 坏、字段类型不对、根对不上、文件已经不在了 —— 一律当「没有快照」，
 * 不猜、不尽力。恢复标签页是便利功能，为它弹一个错误或拦住启动都不值得。
 */

/** 存档键。单独一个，不是别的键的子串。 */
export const SESSION_TABS_STORAGE_KEY = 'nexus-session-tabs';

/** 一个要恢复的标签页。 */
export interface SessionTabEntry {
  /** 绝对路径。 */
  path: string;
  /**
   * 附件要定位到的页码（`#page=` 锚点）。Markdown 条目里恒为 `null`。
   *
   * 跟着路径一起存：恢复一个 PDF 时用户期待它还停在上次看的那页。
   */
  page: number | null;
}

/** 一份快照。 */
export interface SessionSnapshot {
  /** 快照对应的**工作区根**。恢复时根对不上就整份作废。 */
  root: string;
  /** 标签页顺序就是恢复顺序。 */
  entries: readonly SessionTabEntry[];
  /** 上次活动那个文档的路径；没有（活动的是未命名文档）时为 `null`。 */
  activePath: string | null;
}

/** 归档对象里〔可能〕存着的一条。逐字段判，不整体信任。 */
function parseEntry(raw: unknown): SessionTabEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.path !== 'string' || candidate.path === '') return null;
  const page = candidate.page;
  return {
    path: candidate.path,
    page: typeof page === 'number' && Number.isFinite(page) && page >= 1 ? Math.floor(page) : null
  };
}

/**
 * 校验一份已经 `JSON.parse` 过的东西。**任何不对都返回 `null`** ——
 * 与 `parseRecentWorkspace` 同一条判据（磁盘上的文件用户改得动），但方向相反：
 * 那个认不出的值要回落到安全默认，这个直接作废，因为「半个快照」没有意义。
 */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.root !== 'string' || candidate.root === '') return null;
  if (!Array.isArray(candidate.entries)) return null;

  const entries: SessionTabEntry[] = [];
  for (const item of candidate.entries) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }

  const active = candidate.activePath;
  // 活动路径必须真的是其中一条：一个指向已关闭文档的 active 会让激活那一步
  // 静默落空（症状是「恢复了但高亮的是另一个」）。直接归 null 更诚实。
  const activePath =
    typeof active === 'string' && entries.some((entry) => entry.path === active) ? active : null;

  return { root: candidate.root, entries, activePath };
}

/** 序列化。顺序即存储顺序，`parse` 不重排 —— 两处各排一遍就会漂。 */
export function serializeSessionSnapshot(snapshot: SessionSnapshot): string {
  return JSON.stringify({
    root: snapshot.root,
    entries: snapshot.entries.map((entry) => ({ path: entry.path, page: entry.page })),
    activePath: snapshot.activePath
  });
}

/**
 * 两个工作区根是不是**同一个目录**。
 *
 * 需要它是因为同一个目录在这个应用里有多种写法：启动回落给的是命令行原文
 * （`NEXUS_WORKSPACE=d:\vault`），而换工作区时 `openWorkspace` 回的是授权后的路径
 * （`D:\vault`）。严格比字符串会让「同一个人同一天开的同一个库」恢复不了，
 * 而症状（每次重启标签页都空）离原因非常远。
 *
 * 判据刻意宽松但也只到这儿：只折大小写（仅 Windows 盘符路径）与末尾分隔符。
 * 不做 `path.resolve` 那种完整归一 —— 渲染进程没有 node 的 `path`，
 * 而符号链接 / `..` 之间的等价是主进程授权的职责，不该在这里猜。
 */
export function sameWorkspaceRoot(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    // 分隔符先统一成正斜杠：Windows 上同一条路径两种写法都常见
    // （命令行给 `d:\vault`，回落记录里是 `D:/vault`）。
    const unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
    // 只有盘符路径折大小写：那是 Windows 语义，POSIX 路径大小写敏感。
    return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}

/**
 * 读一份。**任何异常（含 JSON 坏）都当没有**—— 见文件头的失败方向。
 */
export function readSessionSnapshot(): SessionSnapshot | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_TABS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;
  try {
    return parseSessionSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 写一份。**内容一模一样就跳过**：调用方是挂在 store snapshot 上的 effect，
 * 保存态变化（`saving` → `clean`）也会触发它，而那份快照其实没变。
 * `setItem` 每次都落盘并广播，跳过它省掉的是磁盘 IO，更是竞态。
 *
 * **失败不抛**：记不住上次的标签页只影响下次启动的便利（隐私模式下
 * `setItem` 会抛 QuotaExceededError，那不是用户该看见的错误）。
 */
export function writeSessionSnapshot(snapshot: SessionSnapshot): void {
  try {
    const serialized = serializeSessionSnapshot(snapshot);
    if (localStorage.getItem(SESSION_TABS_STORAGE_KEY) === serialized) return;
    localStorage.setItem(SESSION_TABS_STORAGE_KEY, serialized);
  } catch {
    // 见上面：便利功能的失败方向是「不记」，不是「报出来」。
  }
}

/** 清掉一份（用户关掉了「恢复标签页」时用）。失败同样不抛。 */
export function clearSessionSnapshot(): void {
  try {
    localStorage.removeItem(SESSION_TABS_STORAGE_KEY);
  } catch {
    // 同上
  }
}
