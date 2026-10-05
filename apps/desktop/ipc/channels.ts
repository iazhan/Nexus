import type { FileWatchEvent } from '@nexus/core';

/**
 * 主进程与 preload 共用的 IPC channel，避免业务代码散落字符串字面量。
 */
export const IPC_CHANNELS = {
  getLaunchContext: 'nexus:get-launch-context',
  openFile: 'nexus:open-file',
  openExternal: 'nexus:open-external',
  /** 把文本写进系统剪贴板（P3-11 的「复制引用」）。 */
  copyText: 'nexus:copy-text',
  readFile: 'nexus:read-file',
  writeFile: 'nexus:write-file',
  saveAs: 'nexus:save-as',
  /**
   * 把粘贴进来的图片落到文档目录下，返回实际落盘的绝对路径。
   *
   * 单独一条而不是复用 `writeFile`：`writeFile` 收的是字符串，图片是字节 ——
   * 过一遍 `utf-8` 解码再编码**不是恒等变换**，PNG 会被改坏。
   */
  saveAttachment: 'nexus:save-attachment',
  /**
   * 删除一个文件。走回收站还是永久删除由 `DeleteMode` 决定（`files.deleteBehavior`）。
   *
   * 与 `saveAttachment` 分开而不是复用它：那是「写」，这是「删」，两者唯一的共同点是
   * 都要过工作区边界。合起来会让一条通道既可能写坏文件也可能删掉文件。
   */
  deleteFile: 'nexus:delete-file',
  /**
   * 重命名一个文件（同目录、只改基名），并按需回写指向它的引用。
   *
   * 一条通道同时承担「试算」与「执行」两件事，用请求里的 `dryRun` 分开：预览要看到的
   * 是**将要发生什么**，而那只有主进程算得出来（它手里才有索引与磁盘）。分成两条通道
   * 会让「预览用的计划」与「执行时重算的计划」成为两份可能漂的代码。
   */
  renameFile: 'nexus:rename-file',
  /**
   * 列出工作区里所有目录的相对路径。
   *
   * 单独一条而不是复用 `scanWorkspace`：那个收的是**文件**，目录是从 `relativePath`
   * 反推的 —— 一个还没放东西的 `assets/` 在它眼里不存在，于是「新建文件夹」点了界面上
   * 什么都不会发生。跳过规则与索引同源，两边的「哪些目录不算」必须一致。
   */
  listWorkspaceDirectories: 'nexus:list-workspace-directories',
  /**
   * 在指定目录下**排他**新建一个空 Markdown 文件。
   *
   * 排他（`open(..., 'wx')`）是这条通道的全部要点：复用 `writeFile` 的话，撞上已存在
   * 的文件会**覆盖**它 —— 而名字是用户随手敲的，撞车是常态，覆盖掉一篇笔记是这条通道
   * 唯一不可逆的失败方式。
   */
  createFile: 'nexus:create-file',
  /**
   * 在指定目录下新建一个子目录（**非递归**）。
   *
   * 非递归是刻意的：`mkdir(recursive: true)` 把「已存在」当成功、不报错，于是撞名时
   * 界面看不出任何区别，用户只会以为自己点漏了。非递归那一档才会抛 `EEXIST`，
   * 与 `createFile` 同形。
   */
  createDirectory: 'nexus:create-directory',
  watchFile: 'nexus:watch-file',
  unwatchFile: 'nexus:unwatch-file',
  fileWatchEvent: 'nexus:file-watch-event',
  /**
   * 打开一个工作区：给了路径就用它，没给就弹目录选择框（与 `openFile` 同形）。
   *
   * 单独一条而不是复用 `authorizeWorkspace`：授权只是这条动作的**一半**，另一半是
   * 把结果记成「下次启动的回落目标」。两者分开写就有中间态 —— 授权了但没记下，
   * 用户下次启动回到旧目录而不知道发生了什么。
   */
  openWorkspace: 'nexus:open-workspace',
  authorizeWorkspace: 'nexus:authorize-workspace',
  scanWorkspace: 'nexus:scan-workspace',
  getWorkspaceRoots: 'nexus:get-workspace-roots',
  rebuildIndex: 'nexus:rebuild-index',
  searchIndex: 'nexus:search-index',
  listIndexedDocuments: 'nexus:list-indexed-documents',
  findBacklinks: 'nexus:find-backlinks',
  listTags: 'nexus:list-tags',
  findDocumentsByTag: 'nexus:find-documents-by-tag',
  getGraph: 'nexus:get-graph',
  getGraphOrphans: 'nexus:get-graph-orphans',
  getGraphHubs: 'nexus:get-graph-hubs',
  findMentions: 'nexus:find-mentions',
  listHistory: 'nexus:list-history',
  readHistory: 'nexus:read-history',
  restoreHistory: 'nexus:restore-history',
  /** 在系统文件管理器里打开 `<workspace>/.nexus/history`。目录不存在时返回 `false`。 */
  openHistoryDirectory: 'nexus:open-history-directory',
  /** 在系统文件管理器里打开该工作区的索引库目录（在 `userData` 下）。不存在时返回 `false`。 */
  openIndexDirectory: 'nexus:open-index-directory',
  /**
   * 该工作区的索引库**文件**路径（`.db`）。设置页把它当只读值显示。
   *
   * 与上面那条是同一个库的两半 —— 两者都由主进程的 `index-path.ts` 算出，所以
   * 「显示的位置」与「打开的位置」不会分家。
   */
  getIndexPath: 'nexus:get-index-path',
  /**
   * 应用版本号（`package.json` 的 `version`）。
   *
   * 设置页把它当只读值显示 —— 「报告问题时看」那一类信息里，用户唯一能自己报出来的就是这个。
   * **主进程答而不是渲染进程答**：渲染进程那边没有版本号（`package.json` 不进包），
   * 而 `app.getVersion()` 拿的就是这个值，不会出现「界面显示的版本与安装包不一致」。
   */
  getAppVersion: 'nexus:get-app-version',
  /**
   * 这个构建**有没有**更新通道 —— 即是否打包过。
   *
   * 单独一条而不是让渲染进程看 `getDiagnostics` 里的某个字段：设置页的「检查更新」按钮
   * 要据此决定禁不禁用（`FieldDef.probe` 返回的是「为什么不能」的字典键，不是数据）。
   * 未打包时 `app-update.yml` 不存在，整条通道是死的 —— 让按钮点得动、点了弹一句
   * 「无法检查更新」，比直接禁用并说明原因更差。
   */
  canCheckUpdates: 'nexus:can-check-updates',
  /**
   * 手动检查更新。**反馈（有新版本 / 已是最新 / 出错）由主进程弹窗承担**，
   * 这条通道只负责「触发」—— 返回值里没有结果，因为没有第二个消费者。
   */
  checkForUpdates: 'nexus:check-for-updates',
  /**
   * 诊断信息：版本、平台、运行时版本、工作区与索引库的文件系统事实。
   *
   * **没有参数、不查授权**（与 `getAppVersion` 同理）：工作区根由主进程从自己的会话里取，
   * 渲染进程不告诉它「要看哪个工作区」—— 那样才不会有「拿一个任意路径来问」的口子。
   *
   * 返回值里**没有文档内容**：这份东西是贴进 issue 的，只能有环境不能有作品。
   */
  getDiagnostics: 'nexus:get-diagnostics',
  setDirty: 'nexus:set-dirty',
  requestSaveAndClose: 'nexus:request-save-and-close',
  readyToClose: 'nexus:ready-to-close',
  closeWindow: 'nexus:close-window',
  minimizeWindow: 'nexus:minimize-window',
  maximizeWindow: 'nexus:maximize-window',
  getWindowState: 'nexus:get-window-state',
  windowStateChanged: 'nexus:window-state-changed',
  /**
   * 打开设置窗口（单例）。
   *
   * 设置是**独立窗口**而不是主窗口内的一个视图 —— 界面上靠 `?window=settings` 查询串区分角色，
   * 不走这里（角色必须在首帧前确定，见主进程的 `WINDOW_ROLE_QUERY`）。这条通道只负责「开窗」。
   */
  openSettingsWindow: 'nexus:open-settings-window',
  /**
   * 打开主题窗口（单例）。与设置窗口同理 —— 角色靠 `?window=theme` 查询串区分，这条通道只负责开窗。
   *
   * 入口在**设置窗口的外观分组**里，不在主窗口：主题编辑器是外观设置的下钻，主窗口不该再多一个齿轮。
   */
  openThemeWindow: 'nexus:open-theme-window',
  /**
   * 「本窗口刚改了本机偏好」。渲染进程 → 主进程，主进程再广播给**其他**窗口。
   *
   * 为什么不用 `window` 的 `storage` 事件（那是原生的跨窗口机制）：dev 下页面来自
   * `http://localhost:6200`、打包后是 `file://`，两种 origin 的 storage 分区语义不同，
   * `storage` 事件在 `file://` 下是否跨窗口派发不能赌。主进程中转是确定的，且两种形态一致。
   */
  notifySettingsChanged: 'nexus:notify-settings-changed',
  /** 上面那条的中转结果。主进程 → 其他窗口。 */
  settingsChanged: 'nexus:settings-changed',
  /**
   * 渲染进程 → 主进程：**把主进程要用的设置值送过去**。
   *
   * 本机偏好存在渲染进程的存储里，主进程读不到（`notifySettingsChanged` 是空载荷的
   * 广播，收方自己去读 —— 而主进程没有可读的地方）。所以凡是要主进程**照着做**的设置，
   * 都得由渲染进程显式送一份过来。
   *
   * 与 `notifySettingsChanged` 分成两条而不是合并：那条是**给别的窗口**的信号
   * （收方各读各的存档），这条是**给主进程**的数据。合并的话主进程就要区分
   * 「这次广播是不是给我的」，而窗口之间的广播本来也不该顺带传值。
   */
  syncHostSettings: 'nexus:sync-host-settings'
} as const;

/**
 * 这个渲染进程是哪个窗口。
 *
 * 定义在这里而不是渲染进程里：主进程的 `loadRenderer()` 与渲染进程的 `readWindowRole()` 必须
 * 是**同一份**联合类型，两边各写一遍的话，加一个角色时漏改一边不会有任何东西报错 ——
 * 主进程照常按新角色加载，渲染进程把它当主窗口渲染。
 */
export type WindowRole = 'main' | 'settings' | 'theme';

/**
 * 设置窗口「落在哪个分组」的查询串参数，与 `window` 参数走同一条路。
 *
 * 定义在这里而不是主进程与渲染进程各写一份：两边必须拼/读同一个名字 —— 各写一遍的话，
 * 改一处漏一处不会有任何东西报错，症状只是「跳转打开了设置窗口却停在旧分组」。
 *
 * **取值不在这里校验**：合法值域是渲染进程的 `SectionId`，主进程不认识它。认不出的值
 * 由渲染进程忽略、回落 `settings.lastSection` —— 与 `readWindowRole()` 的「认不出的值
 * 一律当主窗口」同一个方向：宁可停在默认分组，也不要把用户丢进一个空页。
 */
export const SETTINGS_SECTION_PARAM = 'section';

/**
 * 自绘窗口按钮需要同步的最小状态集合。
 */
export interface WindowState {
  maximized: boolean;
}

/**
 * 一次附件落盘请求。**名字与扩展名已经算好**，主进程不再解释模板 ——
 * 「叫什么」是渲染进程的偏好（模板可改），「放不放得下」才是主进程的事。
 *
 * 形状定义在这里而不是 `electron/file-service.ts`：它是**跨进程的契约**，
 * 而 `NexusBridge`（preload）与 `FileService`（main）两边都要用它。
 * 定义在主进程那一侧的话，preload 只能再写一遍 —— 两份形状漂移不会被任何东西报错。
 */
export interface SaveAttachmentRequest {
  /** 当前文档的绝对路径。附件落在它的目录下 —— 没有文档就没有落点。 */
  documentPath: string;
  /** 相对文档目录的子目录；空串表示与文档同目录。 */
  directory: string;
  /** 不含扩展名的文件名。 */
  fileName: string;
  /** 含前导点的扩展名，如 `.png`。 */
  extension: string;
  /** 文件字节。图片必须原样落盘，过一遍 `utf-8` 解码再编码会把 PNG 改坏。 */
  data: Uint8Array;
}

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * 删一个文件时走哪条路。**两条分支的破坏性不同**，这是整个设计里唯一需要解释的东西：
 *
 * - `trash` —— 移到系统回收站。文件还在磁盘上，用户能从文件管理器找回来，
 *   而且它所在路径上的版本历史也留着（路径对上时历史会跟着回来）。
 * - `permanent` —— 真的没了，连同该文档的版本历史一起。
 *
 * 默认值必须是 `trash`（这也是 `files.deleteBehavior` 的默认档）。主进程收到认不出的值
 * 一律按 `trash` 处理 —— 与 `parseHistoryRetention` 同一条判据：**会删数据的功能，
 * 失败方向必须选「不删」**。这里认不出的值只可能来自一个坏掉的存档或一次手写的 IPC，
 * 两种情形都没有理由让它升级成不可逆。
 */
export type DeleteMode = 'trash' | 'permanent';

/** 上面那个值的全部合法取值，主进程用它校验跨进程传来的 `unknown`。 */
export const DELETE_MODES: readonly DeleteMode[] = ['trash', 'permanent'];

/**
 * 一次重命名请求。
 *
 * 形状定义在这里而不是 `electron/` 里：它是**跨进程的契约**，`NexusBridge`（preload）
 * 与主进程两侧都要用它（同 `SaveAttachmentRequest` 的理由）。
 */
export interface RenameFileRequest {
  /** 被改名文件的绝对路径。 */
  filePath: string;
  /** 新名字，**只含基名**（不含目录）。目录由主进程取原文件的目录 —— 见 `renameFile`。 */
  newName: string;
  /**
   * 是否回写指向它的引用（`files.updateLinksOnRename`）。
   *
   * **随请求传参，不走宿主设置通道。** `syncHostSettings` 存在的理由是「**主进程主动
   * 发起**的行为需要知道设置值」（索引扫描、历史修剪）—— 那些行为没有请求可依附。
   * 重命名是渲染进程请求的，参数跟着请求走；顺手塞进 `HostSettings` 会让「谁在发起」
   * 这条判据模糊掉。
   */
  updateLinks: boolean;
  /**
   * 不要动的文档（绝对路径）。渲染进程把**有未保存修改**的那些放进来。
   *
   * 回写它们等于跟用户的缓冲区打架：主进程改完盘，用户一保存就把回写覆盖回去 ——
   * 那次回写白做，而且用户看不到任何异常。
   *
   * 必填（可以是空数组）：主进程要据此逐项校验，可选字段会逼出「undefined 算不算空」
   * 这种没有正确答案的判断。
   */
  skipPaths: readonly string[];
  /** `true` ＝ 只算计划、不落盘，给预览用。必填，理由同上。 */
  dryRun: boolean;
}

/** 一篇将要（或已经）被改写的文档。`before` / `after` 是**全文**，预览画 diff 用。 */
export interface RenameFileChange {
  path: string;
  relativePath: string;
  before: string;
  after: string;
}

/**
 * 没能自动更新的一处。
 *
 * - `dirty` —— 渲染进程说这篇有未保存的修改，跳过了；
 * - `changed` —— 预览之后、执行之前，这篇的内容在磁盘上变了（别的编辑器写的），跳过；
 * - `unresolved` —— 认出来它指向被改名的那一个，但**写不出来**（名字里有 `]` `|` 之类）；
 * - `failed` —— 写盘本身失败了（占用、权限）。
 *
 * 四种都要**如实报给用户**：静默跳过等于「链接自己断了」，而用户刚被告知过会一起改。
 */
export type RenameSkipReason = 'dirty' | 'changed' | 'unresolved' | 'failed';

export interface RenameFileSkip {
  relativePath: string;
  reason: RenameSkipReason;
  /** 仅 `unresolved`：认出来却写不出来的引用原文。 */
  target?: string;
}

export interface RenameFileResult {
  /** `dryRun` 时是 `null` —— 文件还没改。 */
  renamed: { from: string; to: string; relativePath: string } | null;
  changes: RenameFileChange[];
  skipped: RenameFileSkip[];
}

/**
 * 新建文件 / 新建目录的落点。
 *
 * ## 为什么既要有 `rootPath` 又要有 `directoryPath`
 *
 * 两者答的是不同的问题：`directoryPath` 是**东西放哪**（可以是工作区里的任意子目录），
 * `rootPath` 是**算索引相对路径的基准**（索引里存的是相对工作区根的路径）。
 *
 * `rootPath` 不能由主进程从 `getWorkspaceRoots()` 反推 —— 那个方法返回的是
 * `toPathKey()` 的产物（`path.resolve` + Windows 折叠大小写），是**比较键不是规范路径**。
 * 拿它去 `path.relative` 会得到一个全小写的相对路径，而「显示出来的那条路径指向的文件
 * 必须真的存在」正是这条路径最要紧的性质。
 *
 * 两条通道共用这个形状（名字那一个字段的语义不同，见各自的类型），是因为「落点怎么描述」
 * 只该有一份；分成两个几乎一样的接口只会让将来改一处时漏掉另一处。
 */
interface CreateEntryLocation {
  /** 工作区根。必须是已授权的那个 —— 主进程会拿它校验并算相对路径。 */
  rootPath: string;
  /** 落点目录的**绝对路径**。必须存在、必须是目录、必须在 `rootPath` 之内。 */
  directoryPath: string;
}

/**
 * 新建一个空 Markdown 文件。
 *
 * `fileName` 允许不带扩展名 —— 补 `.md` 的规则在**主进程**（只此一份）。
 * 带了非 Markdown 的扩展名会被拒：这条通道只能造空文本文件。
 */
export interface CreateFileRequest extends CreateEntryLocation {
  fileName: string;
}

/** 新建一个子目录。名字里不能有路径分隔符。 */
export interface CreateDirectoryRequest extends CreateEntryLocation {
  name: string;
}

/**
 * 索引库文件的文件系统事实。
 *
 * `sizeBytes` / `updatedAt` 为 `null` 表示**文件还不存在**（这个工作区还没建过索引）——
 * 与「算不出路径」不是一回事：`path` 在任何情况下都有值，它是工作区路径的纯函数。
 */
export interface DiagnosticsIndexFile {
  path: string;
  sizeBytes: number | null;
  /** ISO 8601（含时区），直接贴出去不会歧义。 */
  updatedAt: string | null;
}

/**
 * 一次诊断快照。**形状定义在这里而不是 `electron/diagnostics.ts`**：它是跨进程契约，
 * `NexusBridge`（preload）与主进程两侧都要用它（同 `SaveAttachmentRequest` 的理由）。
 *
 * 只放**主进程才知道**的东西。渲染进程自己知道的（主题、语言）不放 —— 那些在设置页上
 * 本来就看得见，而它们的取值口径（存档字符串 vs 解析结果）是另一个决定，不该顺手塞进来。
 */
export interface DiagnosticsReport {
  version: string;
  /** `<platform>-<arch>`，如 `win32-x64`。 */
  platform: string;
  electron: string;
  chromium: string;
  node: string;
  /** 已授权的工作区根。轻量模式（只打开一个文件）下是 `null`。 */
  workspaceRoot: string | null;
  /** 没有工作区时是 `null`。 */
  index: DiagnosticsIndexFile | null;
}

/**
 * 主进程需要照着做的那些设置值。
 *
 * **只放「主进程必须知道才能干活」的项**，不放本机偏好本身 —— 这份东西每改一次设置就
 * 过一趟 IPC，塞进全部设置项是白付的序列化，而且会让「哪一项真的影响主进程」变得看不出来。
 * 加一项的条件很硬：**没有它，主进程的某个行为就是错的**。
 *
 * 形状定义在这里而不是 `electron/host-settings.ts`：它是跨进程契约，
 * `NexusBridge`（preload）与主进程两侧都要用它（同 `SaveAttachmentRequest` 的理由）。
 */
export interface HostSettings {
  /**
   * 扫描工作区时跳过的**用户自定义**目录规则（已由 `parseIgnoreRules` 归一化）。
   *
   * 内置规则（点开头目录、`node_modules` / `dist` / `out` / `build`）不在这里 ——
   * 它们不可配置，跟着代码走。这里只放用户加的那部分。
   */
  ignoreRules: readonly string[];
  /**
   * 每个文档最多留几份历史快照。`null` ＝ **不清理**。
   *
   * 送的是**解析后的数值**而不是存档里的字符串（`'unlimited'` / `'100'`）：
   * 「存档格式」是渲染进程的事，主进程只该拿到「留几份」这个答案。
   * 解析规则见 `@nexus/core` 的 `parseHistoryRetention` —— 认不出的值一律当不清理。
   */
  historyRetention: number | null;
  /**
   * 启动时是否恢复上次打开的工作区。
   *
   * **这一项与上面两项有一处结构性的不同**：它的消费者是**下一次启动**的 `launchContext`，
   * 而那东西在主进程模块加载时就定下来了 —— 那时还没有渲染进程能把它送过来。
   * 所以主进程会把它**连同上次的工作区一起落盘**（`electron/recent-workspace.ts`），
   * 这是 `host-settings.ts` 那句「内存而不是落盘」的唯一例外。
   */
  restoreLastWorkspace: boolean;
  /**
   * 被用户关掉的内置能力 id（`plugins.disabled` 归一化后的结果）。
   *
   * **只有主进程那一侧的消费者会用它**：文档处理器（`pdf-text` / `docx-text`）住在主进程，
   * 而「哪个处理器现在不能跑」只有主进程能照着做。渲染进程内那 5 个能力也在这个表里，
   * 但主进程**不认识它们** —— 多出来的 id 一律忽略（与 `sanitizeHostSettings` 对未知键的
   * 态度一致：前向兼容，多送一项不该让整条通道报错）。
   *
   * 送的是**归一化后的 id 列表**而不是存档里的逗号串（`'pdf-text,nexus-math'`）：
   * 「存档格式」是渲染进程的事（`GroupSettingSpec`），主进程只该拿到「哪些被关掉了」。
   */
  disabledCapabilities: readonly string[];
}

/**
 * 一份「什么都还没同步过」的初始值。
 *
 * `historyRetention: null` 就是那个「完全一致」—— 没收到设置之前不删任何历史。
 * 注意它**不等于**设置项的默认档位（100）：默认档位是「用户没选过时界面上显示什么」，
 * 这里是「主进程还没听到用户的选择时该怎么做」，后者必须更保守。
 *
 * `restoreLastWorkspace: true` 与设置项的默认值一致，而不是「更保守」的 `false`：
 * 这一项没有「保守」可言 —— 关掉它只是让人看到欢迎态，不会少删或误删任何东西。
 * 与设置项唱反调反而制造出一个真实的分歧：同一件「用户没表达过偏好」，
 * 主进程说开、渲染进程说开，唯独这里说关。
 *
 * `disabledCapabilities: []` 与设置项的默认值一致，而且这里**没有别的选择**：
 * 空表 ＝ 一个都没关 ＝ 全部启用，正是加启停之前的行为。任何「更保守」的替代
 * （比如默认全关）都会让主进程在收到设置之前什么都不提取。
 */
export const DEFAULT_HOST_SETTINGS: HostSettings = {
  ignoreRules: [],
  historyRetention: null,
  restoreLastWorkspace: true,
  disabledCapabilities: []
};

/**
 * 文件监听 IPC 传输载荷。
 */
export interface FileWatchIpcPayload {
  subscriptionId: string;
  event: FileWatchEvent;
}
