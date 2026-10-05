/**
 * 应用内更新：检查 → 后台下载 → 提示重启安装。通道是 electron-updater 的 GitHub provider，
 * 发布目标是本仓的 Releases（由 `.github/workflows/release.yml` 在打 tag 时产出）。
 *
 * ## 六条判据（改之前先读）
 *
 * 1. **只在打包后可用。** 未打包（`electron-vite dev`）时包里没有 `app-update.yml`，
 *    整条通道是死的。`updatesSupported()` 是唯一的开关 —— 调用方先问它，
 *    而不是让 electron-updater 去抛「找不到配置文件」。状态里的 `unsupported` 阶段是它的投影。
 *
 * 2. **发现新版本就后台下载，但主进程不弹任何原生对话框。**
 *    `autoDownload = true` 配上「启动后自动检查」＝ 开机就开始下。反馈**全部交给渲染进程**：
 *    主窗口一条提示条、更新窗口一个进度条。理由见下一条。
 *
 * 3. **主进程只维护状态，不做 UI。** 这是与旧版最大的不同：旧版在 `update-downloaded` 时
 *    弹一个原生 `dialog`（「立即重启 / 稍后」），而原生对话框**表达不了更新日志、下载进度、
 *    跳过某个版本**。现在主进程只广播 `updateStateChanged`，所有界面在渲染进程 ——
 *    与设置窗口、主题窗口同一个分工。
 *
 *    语言问题随之消失：旧版在主进程里维护了一份 zh/en 弹窗文案，理由是「主进程没有渲染进程
 *    那份 i18n 字典」。界面搬走之后，文案全部回到 `@nexus/i18n`。
 *
 * 4. **有未保存的更改时不给「立即重启」。** 见 `window-dirty.ts` 的头注释：
 *    `quitAndInstall()` 会撞上主窗口的关闭拦截。所以 `installNow()` 会**拒绝**并返回 `false`，
 *    界面据此提示「先保存再退出」；正常退出时 `autoInstallOnAppQuit` 接手。
 *
 * 5. **「有没有新版本」只认 `checkForUpdates()` 返回值上的 `isUpdateAvailable`。**
 *    它在**没有更新时也返回对象**（只有未打包才返回 `null`），而那个对象的
 *    `updateInfo.version` 是**远端那个** —— 本地版本高于远端时它照样是个合法版本号。
 *    拿它跟 `app.getVersion()` 比字符串，会把「远端更低」误判成「有新版本」：
 *    说一句「正在后台下载」，而 `isUpdateAvailable` 为 false 的那一支**压根不建
 *    `downloadPromise`**，于是什么都不会下、`update-downloaded` 永不触发 ——
 *    用户等的是一个永远不来的第二次提示。而「本地领先于远端」恰好是**开发机常态**
 *    （本地版本总比已发布的那个新）。`isUpdateAvailable` 内部是 semver 比较，
 *    且 `allowDowngrade` 默认为 false，等 / 低 / 高三种组合由它一处判对。
 *
 * 6. **「跳过」与「稍后」是两件事，不能合成一个「不再提示」。**
 *    跳过是**针对版本**的、跨会话的、由用户显式表达「这一版我不要」；
 *    稍后是**针对时间**的、有期限的。合成一个会让「我就这次不想看」变成永久关闭。
 *    两者都落盘（见 `update-preferences.ts`），并随状态一起送给渲染进程 ——
 *    「现在该不该显示提示条」的判据因此只需要一份（在渲染进程侧，
 *    因为它才是画那条提示的地方）。
 *
 * ## 状态是单例，广播是唯一的写出口
 *
 * `patch()` 是唯一改状态的地方，它顺手广播。绕开它直接改 `state` 会让界面停在旧值上，
 * 而那种缺陷只在某个特定事件之后才出现 —— 极难查。
 */

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC_CHANNELS, UPDATE_REMIND_INTERVAL_MS, type UpdateState } from '../ipc/channels.js';
import { hasUnsavedWindows } from './window-dirty.js';
import { readUpdatePreferences, writeUpdatePreferences } from './update-preferences.js';

/**
 * 启动后多久开始第一次自动检查。
 *
 * **不是 0**：冷启动的头几秒在扫工作区、建索引，这时候再叠一个网络请求与磁盘写入，
 * 用户感受到的是「打开应用要等很久」。8 秒足够首屏与索引预热跑完。
 */
const AUTO_CHECK_DELAY_MS = 8_000;

/** 未打包时整条通道不可用。**这是唯一该被调用的判据**，不要各处自己判 `app.isPackaged`。 */
export function updatesSupported(): boolean {
  return app.isPackaged;
}

/** 偏好文件所在目录。由主进程注入 —— `update-preferences.ts` 刻意不 import electron。 */
function preferencesDir(): string {
  return app.getPath('userData');
}

let state: UpdateState | null = null;

function baseState(): UpdateState {
  const preferences = readUpdatePreferences(preferencesDir());
  return {
    phase: updatesSupported() ? 'idle' : 'unsupported',
    current: app.getVersion(),
    latest: null,
    skipped: preferences.skippedVersion,
    remindAfter: preferences.remindAfter,
    progress: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    error: null
  };
}

/** 当前状态。**惰性初始化** —— 模块加载时 `app` 还没 ready，而 `getVersion()` 读的是清单文件。 */
export function getUpdateState(): UpdateState {
  state ??= baseState();
  return state;
}

/** 改状态 + 广播。**唯一的写出口**，每一处都从这里走，不会漏广播。 */
function patch(changes: Partial<UpdateState>): UpdateState {
  const next = { ...getUpdateState(), ...changes };
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.updateStateChanged, next);
  }
  return next;
}

let wired = false;

/**
 * 接上更新通道并安排一次自动检查。**在 `app.whenReady()` 之后调用**，未打包时整个函数是空操作。
 *
 * 幂等：重复调用只有第一次生效（`wired`）。窗口重建、设置窗口开关都会走到启动路径附近，
 * 而 `autoUpdater` 是进程级单例，重复挂监听会让一次下载广播 N 次。
 */
export function setupAutoUpdater(): void {
  if (wired || !updatesSupported()) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    patch({ phase: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    patch({ phase: 'available', latest: info.version, error: null });
  });

  autoUpdater.on('update-not-available', (info) => {
    // `info.version` 是**远端那个**，可能比当前低 —— 见判据 5。这里只把它记下来供显示，
    // 「有没有新版」由 `phase` 表达。
    patch({ phase: 'up-to-date', latest: info.version, error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number.isFinite(progress.percent)
      ? Math.min(Math.max(progress.percent / 100, 0), 1)
      : null;
    patch({
      phase: 'downloading',
      progress: percent,
      bytesPerSecond: progress.bytesPerSecond ?? null,
      transferred: progress.transferred ?? null,
      total: progress.total ?? null
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    patch({
      phase: 'downloaded',
      latest: info.version,
      progress: 1,
      bytesPerSecond: null
    });
  });

  // 只记日志，不弹窗：这条流上的一切（DNS、代理、证书、GitHub 限流）都不是用户的错，
  // 而它绝大多数时候发生在用户没要求检查的时候。状态里留一个 `error` 阶段给界面用。
  autoUpdater.on('error', (error) => {
    console.warn('[Nexus] 更新通道出错:', error);
    patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
  });

  const timer = setTimeout(() => {
    void checkNow();
  }, AUTO_CHECK_DELAY_MS);

  // 不让这个定时器拖住退出：用户可能在 8 秒内就关掉应用。
  timer.unref?.();
}

/**
 * 检查更新，返回**检查之后**的状态快照。
 *
 * 出错不往外抛：调用方是 IPC 处理器与启动路径，抛出去在渲染进程那边没有落点
 * （用户会看到「点了没反应」）。错误进 `state.error`，界面按它给一句人话。
 */
export async function checkNow(): Promise<UpdateState> {
  if (!updatesSupported()) return getUpdateState();

  patch({ phase: 'checking', error: null });

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      // 判据是 `isUpdateAvailable`（semver + 不许降级），不是拿版本号比字符串 —— 见判据 5。
      // `autoDownload` 已经在拉了，随后的 `download-progress` 会把阶段推到 `downloading`。
      patch({ phase: 'available', latest: result.updateInfo.version });
    } else {
      patch({ phase: 'up-to-date', latest: result?.updateInfo.version ?? null });
    }
  } catch (error) {
    console.warn('[Nexus] 检查更新失败:', error);
    patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
  }

  return getUpdateState();
}

/**
 * 跳过某个版本：不再为它自动提示。
 *
 * 传的是**版本号**而不是「当前最新」—— 调用方（渲染进程）可能比主进程晚一拍，
 * 让它把自己看到的那个版本号报过来，就不会出现「跳过了 A 却记成 B」。
 */
export function skipVersion(version: string): UpdateState {
  const trimmed = version.trim();
  if (trimmed === '') return getUpdateState();

  writeUpdatePreferences(preferencesDir(), {
    skippedVersion: trimmed,
    // 跳过意味着「这一版不要」，与稍后是互斥的意图 —— 顺手清掉稍后。
    // 两个标记同时存在时「听谁的」要靠约定，而约定会漂。
    remindAfter: null
  });

  return patch({ skipped: trimmed, remindAfter: null });
}

/** 稍后提醒。有期限（`UPDATE_REMIND_INTERVAL_MS`），到期自动恢复提示 —— 不需要任何定时器。 */
export function remindLater(): UpdateState {
  const preferences = readUpdatePreferences(preferencesDir());
  const remindAfter = Date.now() + UPDATE_REMIND_INTERVAL_MS;
  writeUpdatePreferences(preferencesDir(), { ...preferences, remindAfter });
  return patch({ remindAfter });
}

/**
 * 立即重启并安装。**有未保存文档时返回 `false`** —— 不硬来。
 *
 * 返回布尔而不是抛：调用方要据此决定提示哪一句话，而「有未保存文档」是正常路径不是异常。
 */
export function installNow(): boolean {
  if (getUpdateState().phase !== 'downloaded') return false;
  if (hasUnsavedWindows()) return false;
  autoUpdater.quitAndInstall();
  return true;
}
