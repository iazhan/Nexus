import { LOG_LEVEL_DEFAULT, type FileWatchEvent, type LogLevel } from '@nexus/core';
import type { UserTheme } from '@nexus/theme';

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
  /**
   * 读「共同祖先账本」里记的该文档内容（`ConcordLedger.getBase`），供三路合并当 base。
   *
   * 返回 `string | null`：`null` ＝ 这个文档还没进过账本（首次读到之前就被外部改了），
   * **不是空文档**。合并 UI 收到 `null` 就**降级成两路对齐**，而不是拿空串当 base ——
   * 拿空串当 base 会把「两侧都有的内容」全判成「新增」，建议表整个失真。
   *
   * 单独一条而不是并进 `readFile`：那是「读磁盘上现在是什么」（事实源），这是
   * 「读我们上次看到的是什么」（缓存）。两者在合并场景下**必须分开看**，合起来就无从区分。
   */
  readBaseContent: 'nexus:read-base-content',
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
   * 手动检查更新。返回**检查之后的状态快照** —— 更新窗口靠它刷新界面。
   *
   * 与「弹窗反馈」并存而不是取代：自动检查（启动后那次）没有调用方，它的结果只能靠
   * `updateStateChanged` 广播 + 主窗口的提示条表达；手动检查则是「用户点了，
   * 得立刻告诉他结果」。
   */
  checkForUpdates: 'nexus:check-for-updates',
  /**
   * 当前更新状态。**主进程持有**（自动检查由它发起，它也是唯一能读 `app.isPackaged` 的一侧），
   * 渲染进程只读。
   */
  getUpdateState: 'nexus:get-update-state',
  /** 状态变化广播：检查中 / 有新版 / 下载进度 / 下载完成 / 出错。 */
  updateStateChanged: 'nexus:update-state-changed',
  /**
   * 打开更新窗口（单例）。
   *
   * 与设置/主题窗口同形：角色靠 `?window=update` 查询串区分，这条通道只负责开窗。
   * 入口有两处 —— 主窗口的更新提示条，以及设置页的版本行。
   */
  openUpdateWindow: 'nexus:open-update-window',
  /**
   * 跳过某个版本：**不再为它自动提示**。
   *
   * 与「稍后提醒」是两件事：跳过是**针对版本**的、跨会话的、由用户显式表达「这一版我不要」；
   * 稍后是**针对时间**的、有期限的。合成一个「不再提示」会让「我就这次不想看」变成永久关闭。
   */
  skipUpdateVersion: 'nexus:skip-update-version',
  /** 稍后提醒。有期限（见 `UPDATE_REMIND_INTERVAL_MS`），到期后恢复自动提示。 */
  remindUpdateLater: 'nexus:remind-update-later',
  /**
   * 立即重启并安装已下载的更新。
   *
   * **有未保存文档时会拒绝**（返回 `false`）—— `quitAndInstall()` 会撞上主窗口的关闭拦截，
   * 硬来等于把用户的改动丢掉。拒绝之后界面要提示「先保存再退出」。
   */
  installUpdateNow: 'nexus:install-update-now',
  /**
   * 更新日志。**主进程拉**：渲染进程的 CSP `connect-src` 没有 `https:`，发不出外部请求。
   *
   * 三层回落（内置文件 → 远端文件 → GitHub Releases notes），见 `electron/changelog.ts`。
   */
  getChangelog: 'nexus:get-changelog',
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
  syncHostSettings: 'nexus:sync-host-settings',
  /**
   * 首帧主题：**同步**取一次主进程算好的载荷。
   *
   * 唯一一条 `sendSync` 通道，理由只有一个 —— 主题必须在**首帧之前**定下来，而「用哪套主题」
   * 存在渲染进程的 localStorage 里、**主进程读不到**。用户主题的变量还得由主进程派生（它没有
   * 构建期静态 CSS），所以方向是 preload → 主进程 → preload，且必须同步。
   *
   * 不用 `invoke`：那是异步的，等它回来首帧已经画过了 —— 正是这条通道要消除的闪烁。
   */
  getThemeBoot: 'nexus:get-theme-boot',
  /**
   * 把渲染进程手里的主题列表**对齐到目录**（写缺的、删多的）。
   *
   * 整表下发而不是逐条增删：目录是**列表**，一次编辑可能同时改到两三个文件（加一个变体、
   * 并掉一套），逐条通道会让「中间态」变成一种真实存在的磁盘状态。
   */
  syncThemeLibrary: 'nexus:sync-theme-library',
  /**
   * 在系统文件管理器里打开用户主题目录（`<home>/.nexus/themes`）。
   *
   * 与 `openHistoryDirectory` / `openIndexDirectory` 同形，返回**是否真的打开了**。
   * 目录不存在时**先建出来再开** —— 那正是「第一次进来看看放哪」的路径，返回 `false`
   * 会让用户以为这个功能坏了。
   */
  openThemeDirectory: 'nexus:open-theme-directory',
  /**
   * 当前日志**文件**的绝对路径（`<userData>/logs/nexus.log`）。设置页把它当只读值显示。
   *
   * 与下面那条是同一件事的两半：那个把文件管理器开到它所在的**目录**，这个把**文件路径**
   * 交给界面显示。目录里还有轮转出来的历史文件（`nexus.1.log` …），只说「在某个目录下」
   * 等于没说 —— 用户要能一眼认出哪一份是现在的（同 `getIndexPath` 的取舍）。
   *
   * **不接受参数**（与 `getAppVersion` 同理，但理由不同）：日志只有一个文件，是
   * `userData` 的纯函数，没有「拿一个任意路径来问」的口子 —— 那正是 `getIndexPath`
   * 需要查授权的原因。文件还不存在（应用第一次运行）时**照样返回路径**：它是纯函数，
   * 值不依赖文件在不在。
   */
  getLogPath: 'nexus:get-log-path',
  /**
   * 在系统文件管理器里打开日志目录。
   *
   * 与 `openHistoryDirectory` / `openIndexDirectory` / `openThemeDirectory` 同形，
   * 返回**是否真的打开了**。目录不存在时**先建出来再开** —— 这一项最常见的用法就是
   * 「去看看有没有东西」，返回 `false` 会让用户以为日志系统坏了。
   */
  openLogsDirectory: 'nexus:open-logs-directory',
  /**
   * 渲染进程 → 主进程：把一条渲染进程的日志交给主进程写盘。
   *
   * 渲染进程没有文件系统，而它的错误（白屏、IPC 失败、面板加载不出来）恰恰是用户报得最多的
   * 那一类。这条通道是单向的（`send`，不等待回执）：日志不能反过来拖慢它要记录的那件事，
   * 写不写得进去由主进程自己决定。
   */
  writeLog: 'nexus:write-log'
} as const;

/**
 * 一条来自渲染进程的日志。
 *
 * `detail` 是**已经字符串化**的附加信息，不是任意对象：跨进程传一个 `Error` 会得到 `{}`
 * （Electron 的结构化克隆不保留原型），最该记下来的堆栈反而没了。所以由渲染进程先转成文本。
 */
export interface RendererLogEntry {
  level: LogLevel;
  message: string;
  detail?: string;
}

/**
 * 这个渲染进程是哪个窗口。
 *
 * 定义在这里而不是渲染进程里：主进程的 `loadRenderer()` 与渲染进程的 `readWindowRole()` 必须
 * 是**同一份**联合类型，两边各写一遍的话，加一个角色时漏改一边不会有任何东西报错 ——
 * 主进程照常按新角色加载，渲染进程把它当主窗口渲染。
 */
export type WindowRole = 'main' | 'settings' | 'theme' | 'update';

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
  /**
   * 日志级别。主进程的 logger 每次写日志现读它（`electron/logger.ts` 的头注释）。
   *
   * 送的是**认得出的级别**而不是存档字符串：存档格式（`nexus-log-level` 里那个值）是
   * 渲染进程的事，主进程只该拿到「现在按哪一档记」。认不出的值由 `parseLogLevel` 回落默认档 ——
   * 这里与 `historyRetention` 的方向不同（那一项未知值要当「不清理」），
   * 理由见 `logging/level.ts`：级别删不掉任何东西，静默不记才是风险。
   */
  logLevel: LogLevel;
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
  disabledCapabilities: [],
  /**
   * `logLevel` 是这份表里**唯一一个与设置项默认值相同**、而且不存在「更保守」替代的字段。
   *
   * 其余几项都能往「少做事」那一侧倒（不清理历史、不关任何能力），而日志反过来 ——
   * 少记才是风险：主进程在收到渲染进程那份设置之前的这段窗口，正是启动出问题时最需要
   * 现场的那一段。取 `info` 与设置项的默认档一致，两处不会分家。
   */
  logLevel: LOG_LEVEL_DEFAULT
};

/**
 * 文件监听 IPC 传输载荷。
 */
export interface FileWatchIpcPayload {
  subscriptionId: string;
  event: FileWatchEvent;
}

/**
 * 目录里一个读不动的主题文件。
 *
 * `unreadable` = 字节没读出来（权限 / 是目录 / 符号链接 / 太大）；`duplicate-variant` = 同 id
 * 同变体有两份文件（「哪份生效」会取决于文件系统给的顺序）；其余是 base16 的结构化错误码，
 * 由渲染进程翻成文案。
 *
 * 定义在这里而不是 `electron/theme-directory.ts`：它是**跨进程契约**，而那个模块 import 了
 * `node:fs` —— preload 在 sandbox 下拿不到它。形状放这儿，两边只 import 类型。
 */
export type BrokenThemeReason =
  | 'empty'
  | 'not-a-scheme'
  | 'missing-slots'
  | 'invalid-colour'
  | 'unreadable'
  | 'duplicate-variant';

export interface BrokenThemeFile {
  fileName: string;
  reason: BrokenThemeReason;
}

/**
 * preload 发给主进程的首帧请求。
 *
 * `storedThemes` 是 localStorage 里那份用户主题存档的**原文**，不是解析结果 —— 「存档格式」
 * 归渲染进程一侧（`parseUserThemes`），主进程只该拿到「有哪些主题」这个答案，不该自己再解析
 * 一遍 JSON。它是 `null` 表示没有存档。
 *
 * `migrated` 是「那份存档是否已经写出成文件」的标记。为 `false` 且存档非空时，主进程先把它
 * 写出来再答 —— 顺序不能反，先停读再写的话一次磁盘写失败就等于用户主题全丢。
 */
export interface ThemeBootRequest {
  choice: string | null;
  prefersDark: boolean;
  storedThemes: string | null;
  migrated: boolean;
}

/**
 * 首帧载荷：写哪个 `data-theme`、要不要注入一段 CSS，以及**目录的完整快照**。
 *
 * 快照搭这条通道一起走，是因为渲染进程也需要它（主题列表、坏文件清单），而它已经在手上了 ——
 * 再开一条 `invoke` 只会让「首帧用的那批主题」与「列表里显示的那批」成为两次读取。
 */
export interface ThemeBootPayload {
  /** 写到 `<html data-theme>` 上的值。 */
  themeId: string;
  /** `:root { --nexus-… }` 文本。**内置主题是空串**（它们有构建期静态 CSS）。 */
  cssText: string;
  themes: UserTheme[];
  broken: BrokenThemeFile[];
  /** 这一次之后，localStorage 那份存档是否已经写出成文件。 */
  migrated: boolean;
  /**
   * 目录的绝对路径。界面要**显示**它（「放哪」是这个功能唯一的用法说明），也要能打开它 ——
   * 而 `<home>` 只有主进程知道。
   */
  directory: string;
}

/**
 * 一次目录同步的结果。
 *
 * `failed` 非空时**调用方必须说话**：写不进去的主题下次启动就不在了，静默降级等于
 * 「我的主题自己消失了」。
 */
export interface ThemeSyncResult {
  written: number;
  removed: number;
  failed: string[];
}

/**
 * 更新通道当前处于哪一阶段。
 *
 * **`unsupported` 与 `idle` 是两件事**：前者是「这个构建根本没有更新通道」（未打包，
 * `updatesSupported()` 为假），后者是「有通道，但还没检查过」。混成一个会让未打包的界面
 * 显示「尚未检查」，用户一直等一个不会发生的事。
 *
 * `available` 与 `downloading` 也是两件事：`autoDownload = true` 时两者之间只隔一个事件往返，
 * 但**界面要能表达「有新版本」这个事实本身** —— 下载失败时用户至少知道有东西可下，
 * 而不是界面整个退回「已是最新」。
 */
export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

/**
 * 更新状态快照。**主进程是唯一持有者**，渲染进程拿到的每一份都是拷贝。
 *
 * 字段全是基本类型（没有函数、没有 Date）：它要过 IPC，也要进 `updateStateChanged` 广播，
 * 结构化克隆之后仍然相等 —— 渲染进程可以直接浅比较判断要不要重绘。
 */
export interface UpdateState {
  phase: UpdatePhase;
  /** 正在运行的版本。**主进程答**（`app.getVersion()`），渲染进程没有这个值。 */
  current: string;
  /**
   * 远端最新版本。`idle` / `checking` / `error` 时为 `null`。
   *
   * **`up-to-date` 时它是「远端那个」，可能比 `current` 低** —— 开发机常态。
   * 所以判「有没有新版」要认 `phase`，不要拿这两个字段比大小。
   */
  latest: string | null;
  /** 被跳过的版本。等于 `latest` 时不再自动提示（但仍可手动打开更新窗口）。 */
  skipped: string | null;
  /**
   * 「稍后提醒」的截止时刻（epoch 毫秒）。`null` ＝ 没有稍后。
   *
   * **给的是时刻不是布尔**：界面拿它现算「还在稍后期内吗」，到期自动失效，
   * 不需要任何一方在到期时改一个标记。
   */
  remindAfter: number | null;
  /** 下载进度 0–1。不在 `downloading` 时为 `null`。 */
  progress: number | null;
  /** 下载速度（字节/秒）。主进程拿不到时为 `null`。 */
  bytesPerSecond: number | null;
  /** 已接收字节数。不在 `downloading` 时为 `null`。 */
  transferred: number | null;
  /** 总字节数。主进程没报时为 `null`。 */
  total: number | null;
  /** 出错原因（主进程侧的原文）。界面按它给一句人话，不直接展示。 */
  error: string | null;
}

/** 「稍后提醒」的期限：这段时间内不再自动提示，到期恢复。 */
export const UPDATE_REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;

function numericParts(version: string): number[] {
  const core = version.split(/[-+]/, 1)[0] ?? version;
  return core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/**
 * 版本号比较（`x.y.z` 三段；prerelease 尾巴忽略 —— `0.74.0-beta.1` 与 `0.74.0` 同段）。
 *
 * **放在这里而不是两侧各写一份**：主进程用它给更新日志排序，渲染进程用它筛「比当前版本新的那些」，
 * 两处口径必须一致 —— 一份把 prerelease 排前面、另一份排后面的话，界面会漏掉或重复某些版本。
 * 而 `channels.ts` 正是两侧共享的中性层（`DELETE_MODES` 那份校验常量也在这里）。
 *
 * **认不出的版本号不抛**：缺的段补 0，非数字补 0。输入来自网络与他人手写的 JSON。
 */
export function compareVersions(a: string, b: string): number {
  const left = numericParts(a);
  const right = numericParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 一条更新日志条目。
 *
 * `zh` / `en` **至少有一个非空**（解析器保证）；界面按当前语言挑，缺的那个回落到另一个。
 * 于是「中文还没补」的版本在英文界面下照常可读，反之亦然 —— 双语日志是**渐进补全**的，
 * 不是「要么都有、要么都没有」。
 */
export interface ChangelogEntry {
  /** 提交类型（`feat` / `fix` / …）。解析不出是 `null`。 */
  type: string | null;
  /** 改动范围（`desktop` / `editor` / …）。解析不出是 `null`。 */
  scope: string | null;
  zh: string | null;
  en: string | null;
}

/** 一个版本的更新日志。 */
export interface ChangelogRelease {
  /** `0.74.0` —— 不带前导 `v`，比较与显示都用它。 */
  version: string;
  /** `YYYY-MM-DD`。缺失时为 `null`。 */
  date: string | null;
  entries: ChangelogEntry[];
  /**
   * 这一条是从哪来的。**界面要如实区分** —— 从 GitHub 提交信息回落的那些是英文的，
   * 而且早期版本可能一条都没有（那时流水线还没生成 notes）。
   */
  source: 'bundled' | 'remote' | 'github';
}

/**
 * 更新日志查询结果。
 *
 * `null` = **一条都没拿到**（三层回落全失败）。与空数组是两件事：空数组是「拿到了，
 * 但没有比当前版本更新的条目」，界面文案不同（前者「无法获取」，后者「已是最新」）。
 */
export type ChangelogResult = ChangelogRelease[] | null;

/**
 * 仓库里那份双语更新日志的形状（`changelog.json`）。
 *
 * **版本为键**：查一个版本的日志是 `record[version]`，不用遍历数组 —— 而它最常被用来答的
 * 就是「这一个版本改了什么」。
 */
export interface ChangelogFile {
  /** 版本号 → 条目。`changes` 与 `ChangelogEntry` 同形，但两个语言字段都可缺。 */
  [version: string]: {
    date?: string;
    changes?: {
      type?: string;
      scope?: string;
      zh?: string;
      en?: string;
    }[];
  };
}
