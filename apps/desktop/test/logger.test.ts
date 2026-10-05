import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLevel } from '@nexus/core';
import {
  initLogger,
  logDebug,
  logError,
  logFilePathOrNull,
  logInfo,
  logWarn,
  resetLogger
} from '../electron/logger.js';

let root: string;
/** 当前级别。测试通过改它来验证「现读」而不是「init 时定死」。 */
let level: LogLevel;
/** 被写进文件的那些行。 */
function lines(): string[] {
  const filePath = logFilePathOrNull();
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line !== '');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-logger-'));
  level = 'info';
  resetLogger();
  // 主进程的 logger 同时写控制台（那是 dev 时的观察面），这里静音以免污染测试输出。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  resetLogger();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('主进程 logger · 级别过滤', () => {
  it('低于当前级别的丢掉，不低于的留下', () => {
    initLogger({ directory: root, level: () => level });

    logError('这条要留');
    logWarn('这条也要留');
    logInfo('这条还要留');
    logDebug('这条要丢');

    const written = lines().join('\n');
    expect(written).toContain('这条要留');
    expect(written).toContain('这条也要留');
    expect(written).toContain('这条还要留');
    expect(written).not.toContain('这条要丢');
  });

  it('正反两面：调到 error 时 warn 消失、error 还在', () => {
    initLogger({ directory: root, level: () => level });

    logWarn('静音前的 warn');
    logError('一直在的 error');

    level = 'error';
    logWarn('静音后的 warn');
    logError('之后的 error');

    const written = lines().join('\n');
    expect(written).toContain('静音前的 warn');
    expect(written).not.toContain('静音后的 warn');
    expect(written).toContain('一直在的 error');
    expect(written).toContain('之后的 error');
  });

  it('级别是现读的 —— 拨开关立即生效，不需要重新 init', () => {
    // 定死级别的症状是「在设置里调到 debug，重启才生效」，而那种错在界面上看不出来。
    initLogger({ directory: root, level: () => level });

    logDebug('第一段：应该被丢掉');
    level = 'debug';
    logDebug('第二段：应该留下');

    const written = lines().join('\n');
    expect(written).not.toContain('第一段');
    expect(written).toContain('第二段');
  });

  it('一条都不写时不建文件 —— 静音不该留下一个空文件让人以为日志坏了', () => {
    level = 'error';
    initLogger({ directory: root, level: () => level });

    logDebug('丢');
    logInfo('也丢');

    expect(lines()).toEqual([]);
  });
});

describe('主进程 logger · init 之前攒着', () => {
  it('init 前记的日志在 init 之后补写出来', () => {
    // 启动参数解析、工作区恢复这些发生在 `app.getPath('userData')` 可算之前，
    // 而「为什么这次没进工作区」的答案就在里面。
    logInfo('init 之前的启动信息');

    expect(lines()).toEqual([]);

    initLogger({ directory: root, level: () => level });

    expect(lines().join('\n')).toContain('init 之前的启动信息');
  });

  it('补写时按**当时**的级别过滤，不是按默认档', () => {
    level = 'error';
    logInfo('不该出现');
    logError('该出现');

    initLogger({ directory: root, level: () => level });

    const written = lines().join('\n');
    expect(written).not.toContain('不该出现');
    expect(written).toContain('该出现');
  });

  it('攒下的条数有上限，超了丢最老的而不是最新的', () => {
    for (let index = 0; index < 520; index += 1) logInfo(`第 ${index} 条`);

    initLogger({ directory: root, level: () => level });

    const written = lines().join('\n');
    expect(written).not.toContain('第 0 条');
    expect(written).toContain('第 519 条');
    // 上限 500：最老的 20 条被丢掉。
    expect(lines()).toHaveLength(500);
  });
});

describe('主进程 logger · 失败不拖累调用方', () => {
  it('目录写不进去也不抛 —— 记日志本身绝不能让业务操作失败', () => {
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory', 'utf8');
    initLogger({ directory: blocked, level: () => level });

    expect(() => logError('保存失败', new Error('磁盘满'))).not.toThrow();
    expect(() => logWarn('继续跑')).not.toThrow();
  });

  it('写盘失败会在控制台喊一声 —— 静默的话用户以为盘上有东西', () => {
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory', 'utf8');
    initLogger({ directory: blocked, level: () => level });

    logError('第一条');

    const messages = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('日志写盘失败'))).toBe(true);
  });
});
