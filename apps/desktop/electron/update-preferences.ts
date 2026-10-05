/**
 * 更新的两个「用户表达」：**跳过某个版本**、**稍后提醒**。
 *
 * ## 为什么落盘在主进程，而不走渲染进程的存档
 *
 * 与 `recent-workspace.ts` 同一条理由：**读它的是主进程，而且读的时机早于任何渲染进程**。
 * 自动检查由主进程在启动后几秒发起，它要在「决定要不要提示」之前就知道这一版被跳过没有 ——
 * 那一刻渲染进程可能还没把存档送过来，甚至可能根本没开窗口。
 *
 * 走宿主设置通道（`syncHostSettings`）也行，但那要求「每次改设置都过一趟 IPC」，
 * 而这两个值**只有主进程消费**（渲染进程只是把它读回来显示）。放主进程自己的落盘更直接。
 *
 * ## 失败方向：一律当成「没跳过、没稍后」
 *
 * 文件缺失、读不动、JSON 坏、字段类型不对 → 全都回落成「该提示就提示」。
 * 反过来（认不出就当「已跳过」）会让一个坏文件**永久静默**所有更新提示 ——
 * 用户再也收不到新版本，而且没有任何地方看得出为什么。
 * 与 `recent-workspace.ts` 的「目录那一半一律不恢复」同一个方向：会丢东西的那一侧选保守。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 文件名。放 `userData` 根下而不是子目录：它只有一个，不值得为它建一层。 */
export const UPDATE_PREFERENCES_FILE = 'update-preferences.json';

export interface UpdatePreferences {
  /** 被跳过的版本（不带前导 `v`）。`null` ＝ 没有跳过任何版本。 */
  skippedVersion: string | null;
  /**
   * 「稍后提醒」的截止时刻（epoch 毫秒）。`null` ＝ 没有稍后。
   *
   * **存时刻而不是「要不要提醒」**：一个布尔值到期后没法自己变回来，
   * 得靠某个东西在到期时改它 —— 而那正是「谁在什么时候改」这种容易漏的接线。
   * 存时刻的话，判据是每次读的时候现算的（`Date.now() < remindAfter`），
   * 到期自动失效，不需要任何定时器。
   */
  remindAfter: number | null;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  skippedVersion: null,
  remindAfter: null
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 把任意 JSON 值收敛成一份合法的偏好。**不抛** —— 调用方在启动路径上。 */
export function parseUpdatePreferences(raw: unknown): UpdatePreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_UPDATE_PREFERENCES };
  }
  const record = raw as Record<string, unknown>;
  const remindAfter = record.remindAfter;
  return {
    skippedVersion: nonEmptyString(record.skippedVersion),
    remindAfter:
      typeof remindAfter === 'number' && Number.isFinite(remindAfter) && remindAfter > 0
        ? remindAfter
        : null
  };
}

/** 读。**任何失败都回落成默认值**。 */
export function readUpdatePreferences(dir: string): UpdatePreferences {
  try {
    const text = fs.readFileSync(path.join(dir, UPDATE_PREFERENCES_FILE), 'utf8');
    return parseUpdatePreferences(JSON.parse(text));
  } catch {
    return { ...DEFAULT_UPDATE_PREFERENCES };
  }
}

/**
 * 写。**失败只记日志，不抛**。
 *
 * 跳过 / 稍后都是「这次别提示我」这种程度的意图 —— 写不进去最坏的结果是下次还提示，
 * 而为它把更新窗口炸掉显然更糟。
 */
export function writeUpdatePreferences(dir: string, prefs: UpdatePreferences): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, UPDATE_PREFERENCES_FILE),
      `${JSON.stringify(prefs, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn('[Nexus] 更新偏好写盘失败:', error);
  }
}
