/**
 * UI 缩放的**唯一取值口径**：磁盘键、档位、解析、百分数 → 倍率。
 *
 * ## 为什么它住在 `preload/` 而不是 `renderer/src/settings/preference-specs.ts`
 *
 * 缩放改的是整个**布局视口**，必须在首帧之前应用 —— 晚一帧就是「先按 100% 画一帧再跳」。
 * 首帧之前只有 preload 能跑（`theme-boot.ts` 是同一个理由），所以这份口径必须放在 preload
 * 拿得到的地方，renderer 反过来读它。这与 `preload/types.ts` 是同一个方向：**preload 提供、
 * renderer 读**（`tsconfig.web.json` 已按那个理由单独收录了它，这个文件同理）。
 *
 * 分开写两份是不可能的：preload 那份要能挡住存档里的越界值（读到 `1000` 就是 10 倍缩放，
 * 用户连设置窗口都看不清、改不回来），renderer 那份要给出档位标签 —— 两份「哪些值合法」
 * 迟早对不上，而症状是「设置页显示 125%、实际按 150% 画」。
 *
 * ## 为什么是档位而不是滑块 / 输入框
 *
 * 与 `editor.contentWidth` 同一条判据：**档位把「合法的值」变成选项本身**，顺带省掉解析与
 * 越界处理。自由输入在这里尤其不划算 —— 一个手滑的 `1000` 会把窗口变成没法操作的样子。
 */

export const UI_ZOOM_STORAGE_KEY = 'nexus-ui-zoom';

/** 档位（百分数的字符串形式，磁盘上存的就是它）。 */
export const UI_ZOOM_OPTIONS: readonly string[] = ['80', '90', '100', '110', '125', '150', '175', '200'];

export const UI_ZOOM_DEFAULT = '100';

/** 磁盘字符串 → 档位。认不出的值一律回落到默认 —— 存档是用户能改的。 */
export function parseUiZoom(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return UI_ZOOM_DEFAULT;
  const trimmed = raw.trim();
  return UI_ZOOM_OPTIONS.includes(trimmed) ? trimmed : UI_ZOOM_DEFAULT;
}

/** 档位 → `webFrame.setZoomFactor` 要的倍率（100 → 1）。 */
export function uiZoomFactor(value: string): number {
  return Number(parseUiZoom(value)) / 100;
}

/**
 * 读存档里的档位。存储被禁用（隐私模式、CSP）时按默认值走，不抛 ——
 * 首帧之前抛错会让整个窗口起不来。
 */
export function readStoredUiZoom(win: Window): string {
  try {
    return parseUiZoom(win.localStorage.getItem(UI_ZOOM_STORAGE_KEY));
  } catch {
    return UI_ZOOM_DEFAULT;
  }
}

/**
 * 把存档里的缩放应用到当前窗口。`setZoomFactor` 由调用方注入 —— 这个模块要保持**纯的**，
 * 不能 import `electron`（renderer 也会 import 它，那会把整个 electron 模块拖进页面包）。
 */
export function applyStoredUiZoom(win: Window, setZoomFactor: (factor: number) => void): void {
  setZoomFactor(uiZoomFactor(readStoredUiZoom(win)));
}
