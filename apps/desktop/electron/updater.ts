/**
 * 应用内更新：检查 → 后台下载 → 提示重启安装。通道是 electron-updater 的 GitHub provider，
 * 发布目标是本仓的 Releases（由 `.github/workflows/release.yml` 在打 tag 时产出）。
 *
 * ## 四条判据（改之前先读）
 *
 * 1. **只在打包后可用。** 未打包（`electron-vite dev`）时包里没有 `app-update.yml`，
 *    整条通道是死的。`updatesSupported()` 是唯一的开关 —— 调用方先问它，
 *    而不是让 electron-updater 去抛「找不到配置文件」。
 *
 * 2. **发现新版本就后台下载，只在「下载完成」时打断用户一次。**
 *    `autoDownload = true` 配上「启动后自动检查」＝ 开机就开始下；而下载完不弹窗，
 *    用户就永远不知道该重启。所以弹窗**只挂在 `update-downloaded` 上**，
 *    `update-available` 与 `error` 都静默 —— 自动检查失败（没网、代理、GitHub 抽风）
 *    不该打扰一个没要求检查的人。
 *
 * 3. **有未保存的更改时不给「立即重启」。** 见 `window-dirty.ts` 的头注释：
 *    `quitAndInstall()` 会撞上主窗口的关闭拦截。脏的时候只提示「退出时装」，
 *    由 `autoInstallOnAppQuit` 在那次正常退出（用户已保存）时接手。
 *
 * 4. **弹窗文案的判据是系统语言，不是应用内语言。** 主进程没有渲染进程那份 i18n 字典，
 *    而自动检查在启动后几秒就跑了，那时没有窗口能把它送过来。两者不一致时弹窗会是
 *    系统语言 —— 这是刻意接受的：为一年响不了几次的弹窗新增一条「把 locale 送给主进程」
 *    的宿主设置通道不划算。真要改，改法是把它加进 `HostSettings`（见 `ipc/channels.ts`
 *    里那份「加一项的条件」）。
 */

import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import { hasUnsavedWindows } from './window-dirty.js';

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

interface Messages {
  readyTitle: string;
  readyMessage(version: string): string;
  readyDetail: string;
  restartNow: string;
  later: string;
  unsavedTitle: string;
  unsavedMessage(version: string): string;
  unsavedDetail: string;
  upToDateTitle: string;
  upToDateMessage(version: string): string;
  startedTitle: string;
  startedMessage(version: string): string;
  failedTitle: string;
  unavailableTitle: string;
  unavailableMessage: string;
}

const MESSAGES: Record<'zh' | 'en', Messages> = {
  zh: {
    readyTitle: '更新已就绪',
    readyMessage: (version) => `Nexus ${version} 已下载完成。`,
    readyDetail: '重启应用即可用上新版本。选择「稍后」则在下次退出时自动安装。',
    restartNow: '立即重启',
    later: '稍后',
    unsavedTitle: '有未保存的更改',
    unsavedMessage: (version) => `Nexus ${version} 已下载完成，但当前有文档尚未保存。`,
    unsavedDetail: '请先保存这些文档，然后退出应用 —— 更新会在退出时自动安装。',
    upToDateTitle: '已是最新版本',
    upToDateMessage: (version) => `当前版本 ${version} 已经是最新的。`,
    startedTitle: '发现新版本',
    startedMessage: (version) => `Nexus ${version} 正在后台下载，完成后会提示你重启。`,
    failedTitle: '检查更新失败',
    unavailableTitle: '无法检查更新',
    unavailableMessage: '开发模式下没有更新通道，请使用打包后的版本。'
  },
  en: {
    readyTitle: 'Update ready',
    readyMessage: (version) => `Nexus ${version} has finished downloading.`,
    readyDetail: 'Restart to start using it. Choosing "Later" installs it when you next quit.',
    restartNow: 'Restart now',
    later: 'Later',
    unsavedTitle: 'Unsaved changes',
    unsavedMessage: (version) => `Nexus ${version} is ready, but some documents have unsaved changes.`,
    unsavedDetail: 'Save them first, then quit — the update installs itself on exit.',
    upToDateTitle: 'Up to date',
    upToDateMessage: (version) => `You are already on the latest version, ${version}.`,
    startedTitle: 'Update found',
    startedMessage: (version) => `Nexus ${version} is downloading in the background.`,
    failedTitle: 'Update check failed',
    unavailableTitle: 'Update check unavailable',
    unavailableMessage: 'There is no update channel in development builds.'
  }
};

function messages(): Messages {
  return app.getLocale().toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en;
}

/**
 * 弹窗挂在**当前聚焦的窗口**上。
 *
 * 不传父窗口时 `showMessageBox` 是应用级模态，在无边框多窗口的界面上它可能落在别的窗口
 * 后面 —— 用户看不到，却按不动任何东西。
 */
function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessage(options: Electron.MessageBoxOptions): Promise<void> {
  const parent = parentWindow();
  if (parent) {
    await dialog.showMessageBox(parent, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

async function promptInstall(info: UpdateInfo): Promise<void> {
  const m = messages();

  if (hasUnsavedWindows()) {
    await showMessage({
      type: 'info',
      title: m.unsavedTitle,
      message: m.unsavedMessage(info.version),
      detail: m.unsavedDetail,
      buttons: [m.later],
      defaultId: 0
    });
    return;
  }

  const parent = parentWindow();
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: m.readyTitle,
    message: m.readyMessage(info.version),
    detail: m.readyDetail,
    buttons: [m.restartNow, m.later],
    defaultId: 0,
    cancelId: 1
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  if (response === 0) autoUpdater.quitAndInstall();
}

let wired = false;

/**
 * 接上更新通道并安排一次自动检查。**在 `app.whenReady()` 之后调用**，未打包时整个函数是空操作。
 *
 * 幂等：重复调用只有第一次生效（`wired`）。窗口重建、设置窗口开关都会走到启动路径附近，
 * 而 `autoUpdater` 是进程级单例，重复挂监听会让一次下载弹 N 个窗。
 */
export function setupAutoUpdater(): void {
  if (wired || !updatesSupported()) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    void promptInstall(info);
  });

  // 只记日志，不弹窗：这条流上的一切（DNS、代理、证书、GitHub 限流）都不是用户的错，
  // 而它绝大多数时候发生在用户没要求检查的时候。
  autoUpdater.on('error', (error) => {
    console.warn('[Nexus] 更新通道出错:', error);
  });

  const timer = setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn('[Nexus] 自动检查更新失败:', error);
    });
  }, AUTO_CHECK_DELAY_MS);

  // 不让这个定时器拖住退出：用户可能在 8 秒内就关掉应用。
  timer.unref?.();
}

/**
 * 手动检查更新（设置页的按钮）。**反馈由这里弹窗承担**，所以返回 `void` ——
 * 让渲染进程再拿一个结果类型只会多出一份「谁来显示」的重复判断。
 *
 * 出错不往外抛：`FieldDef.run` 抛出的异常在设置页里没有落点，用户会看到「点了没反应」。
 */
export async function checkForUpdatesManually(): Promise<void> {
  const m = messages();

  if (!updatesSupported()) {
    await showMessage({ type: 'info', title: m.unavailableTitle, message: m.unavailableMessage });
    return;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;

    if (!latest || latest === app.getVersion()) {
      await showMessage({
        type: 'info',
        title: m.upToDateTitle,
        message: m.upToDateMessage(app.getVersion())
      });
      return;
    }

    // 有新版本：`autoDownload` 已经在拉了，下载完 `promptInstall` 会再弹一次。
    // 这一句只是告诉用户「点了有反应」，别让他以为按钮坏了。
    await showMessage({
      type: 'info',
      title: m.startedTitle,
      message: m.startedMessage(latest)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await showMessage({ type: 'error', title: m.failedTitle, message: detail });
  }
}
