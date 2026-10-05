// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_UPDATE_PREFERENCES,
  parseUpdatePreferences,
  readUpdatePreferences,
  UPDATE_PREFERENCES_FILE,
  writeUpdatePreferences
} from '../electron/update-preferences.js';
import { createTempDir } from './smoke-harness.js';

/**
 * 更新的两个「用户表达」：跳过某个版本、稍后提醒。
 *
 * 这一层能在**不启动 Electron** 的前提下测全，靠的是与 `recent-workspace.ts` 同一条纪律：
 * 模块收的是**目录**而不是自己去问 `app.getPath('userData')`。
 *
 * 重点在**失败方向**：认不出的一律回落成「该提示就提示」。
 * 反过来（认不出就当「已跳过」）会让一个坏文件**永久静默**所有更新提示。
 */

describe('更新偏好 · 解析', () => {
  it('认不出的一律回落成默认值', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expect(parseUpdatePreferences(raw)).toEqual(DEFAULT_UPDATE_PREFERENCES);
    }
  });

  it('字段类型不对时逐项回落，而不是整份丢掉', () => {
    expect(parseUpdatePreferences({ skippedVersion: 42, remindAfter: 'soon' })).toEqual({
      skippedVersion: null,
      remindAfter: null
    });
  });

  it('空串与全空白都不算一个版本号', () => {
    expect(parseUpdatePreferences({ skippedVersion: '' }).skippedVersion).toBeNull();
    expect(parseUpdatePreferences({ skippedVersion: '   ' }).skippedVersion).toBeNull();
  });

  it('版本号两端的空白会被去掉', () => {
    expect(parseUpdatePreferences({ skippedVersion: ' 0.74.0 ' }).skippedVersion).toBe('0.74.0');
  });

  it('零、负数、非有限数都不是合法的截止时刻', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseUpdatePreferences({ remindAfter: value }).remindAfter).toBeNull();
    }
  });

  it('一份合法的偏好原样通过', () => {
    expect(
      parseUpdatePreferences({ skippedVersion: '0.74.0', remindAfter: 1_700_000_000_000 })
    ).toEqual({ skippedVersion: '0.74.0', remindAfter: 1_700_000_000_000 });
  });
});

describe('更新偏好 · 落盘', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDir('nexus-update-prefs-');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('没写过时读到默认值 —— 文件不存在不是错误', () => {
    expect(readUpdatePreferences(directory)).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(fs.existsSync(path.join(directory, UPDATE_PREFERENCES_FILE))).toBe(false);
  });

  it('写进去再读回来是同一份', () => {
    const preferences = { skippedVersion: '0.74.0', remindAfter: 1_700_000_000_000 };
    writeUpdatePreferences(directory, preferences);
    expect(readUpdatePreferences(directory)).toEqual(preferences);
  });

  it('文件坏掉时回落成默认值，而不是抛 —— 调用方在启动路径上', () => {
    fs.writeFileSync(path.join(directory, UPDATE_PREFERENCES_FILE), '{ not json', 'utf8');
    expect(readUpdatePreferences(directory)).toEqual(DEFAULT_UPDATE_PREFERENCES);
  });

  it('目录还不存在时会建出来', () => {
    const nested = path.join(directory, 'a', 'b');
    writeUpdatePreferences(nested, { skippedVersion: '0.74.0', remindAfter: null });
    expect(readUpdatePreferences(nested).skippedVersion).toBe('0.74.0');
  });

  it('写盘失败不抛 —— 跳不过去是小事，把界面炸掉是大事', () => {
    // 拿一个「父级是文件」的路径当目录，`mkdirSync` 必然失败。
    const blocker = path.join(directory, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    expect(() =>
      writeUpdatePreferences(path.join(blocker, 'nested'), DEFAULT_UPDATE_PREFERENCES)
    ).not.toThrow();
  });
});
