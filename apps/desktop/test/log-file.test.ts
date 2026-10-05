import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_FILE_KEEP,
  LOG_FILE_NAME,
  LOG_DIR_NAME,
  createLogFileSink,
  formatLogLine,
  formatTimestamp,
  logFilePath,
  logsDirectoryFor,
  rotatedLogPath
} from '../electron/log-file.js';

/**
 * 这一整个文件是**纯 node**的：落盘器收一个目录字符串、不 import electron，
 * 所以轮转与降级都能在这里跑完，不需要启动窗口。
 */

let root: string;

beforeEach(() => {
  // 前缀必须是 `nexus-`：`sweepStaleTempDirs()` 靠它认领遗留目录（见 global-setup.ts）。
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-log-file-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('日志路径', () => {
  it('目录是 `<userData>/logs`，文件是 `nexus.log`', () => {
    expect(logsDirectoryFor('C:\\data')).toBe(path.join('C:\\data', LOG_DIR_NAME));
    expect(logFilePath(logsDirectoryFor('C:\\data'))).toBe(
      path.join('C:\\data', LOG_DIR_NAME, LOG_FILE_NAME)
    );
  });

  it('轮转文件保留扩展名：`nexus.1.log`，不是 `nexus.log.1`', () => {
    // 顺序错了不影响「能不能写」，只影响用户按类型筛选 / 用编辑器打开时的体验 ——
    // 一个 `.log.1` 在资源管理器里没有图标，双击也打不开。
    expect(rotatedLogPath('/logs', 1)).toBe(path.join('/logs', 'nexus.1.log'));
    expect(rotatedLogPath('/logs', 3)).toBe(path.join('/logs', 'nexus.3.log'));
  });
});

describe('时间戳', () => {
  it('本地时间 + 毫秒 + 时区偏移', () => {
    const at = new Date(2026, 9, 5, 23, 40, 12, 345);
    // 只钉形状，不钉具体偏移值 —— 那条取决于跑测试的机器在哪个时区。
    expect(formatTimestamp(at)).toMatch(
      /^2026-10-05 23:40:12\.345 [+-]\d{2}:\d{2}$/
    );
  });

  it('偏移量与 `getTimezoneOffset` 反号，且小时部分补零', () => {
    const at = new Date(2026, 9, 5, 0, 0, 0, 0);
    const offsetMinutes = -at.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? '-' : '+';
    const absolute = Math.abs(offsetMinutes);
    const expected = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(
      absolute % 60
    ).padStart(2, '0')}`;
    expect(formatTimestamp(at).endsWith(expected)).toBe(true);
  });
});

describe('单行组装', () => {
  const at = new Date(2026, 9, 5, 23, 40, 12, 345);

  it('没有附加信息时不画分隔符', () => {
    const line = formatLogLine({ at, level: 'info', message: '[Nexus Shell] 启动' });
    expect(line).toMatch(/^2026-10-05 23:40:12\.345 [+-]\d{2}:\d{2} \[info\] \[Nexus Shell\] 启动$/);
  });

  it('Error 的堆栈被压成一行 —— 一条日志必须占一行', () => {
    const line = formatLogLine({ at, level: 'error', message: '保存失败', detail: new Error('磁盘满') });
    expect(line).toContain('磁盘满');
    // 转义后的 `\n` 是字面量反斜杠加 n，不是真换行 —— 按行读的工具才不会把后面几十行吃掉。
    expect(line).not.toContain('\n');
    expect(line).toContain('\\n');
  });

  it('普通对象用 inspect 而不是 JSON —— Error 走 JSON 会变成 `{}`', () => {
    const line = formatLogLine({ at, level: 'warn', message: '载荷异常', detail: { path: '/a', count: 2 } });
    expect(line).toContain('path');
    expect(line).toContain('/a');
    expect(line).toContain('count');
  });

  it('循环引用不抛 —— 抛在这里等于丢一条日志', () => {
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;
    expect(() => formatLogLine({ at, level: 'debug', message: 'x', detail: circular })).not.toThrow();
  });

  it('null / undefined 当作「没有附加信息」，不画 `| null`', () => {
    for (const detail of [null, undefined]) {
      expect(formatLogLine({ at, level: 'info', message: 'm', detail })).not.toContain('|');
    }
  });
});

describe('落盘器 · 写入', () => {
  it('目录不存在时自己建出来，写进去的内容按行追加', () => {
    const directory = logsDirectoryFor(root);
    const sink = createLogFileSink({ directory });

    expect(sink.write('第一行')).toBe(true);
    expect(sink.write('第二行')).toBe(true);

    const content = fs.readFileSync(sink.filePath, 'utf8');
    expect(content).toBe('第一行\n第二行\n');
    expect(sink.broken).toBe(false);
  });

  it('已有文件时接着写，不截断 —— 否则每次启动都吃掉上次的现场', () => {
    const directory = logsDirectoryFor(root);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, LOG_FILE_NAME), '上次的\n', 'utf8');

    const sink = createLogFileSink({ directory });
    sink.write('这次的');

    expect(fs.readFileSync(sink.filePath, 'utf8')).toBe('上次的\n这次的\n');
  });
});

describe('落盘器 · 轮转', () => {
  /** 每行连换行 31 字节。阈值 40 时，第二行就必然触发一次轮转。 */
  const line = (marker: string): string => marker.padEnd(30, 'x');

  it('超过上限时换文件，历史按 1、2… 往后推', () => {
    const directory = logsDirectoryFor(root);
    const sink = createLogFileSink({ directory, maxBytes: 40, keep: 2 });

    sink.write(line('A'));
    sink.write(line('B'));
    sink.write(line('C'));

    expect(fs.readFileSync(sink.filePath, 'utf8')).toContain('C');
    expect(fs.readFileSync(rotatedLogPath(directory, 1), 'utf8')).toContain('B');
    expect(fs.readFileSync(rotatedLogPath(directory, 2), 'utf8')).toContain('A');
  });

  it('保留份数是硬上限 —— 最老的那份被删掉，而不是无限堆下去', () => {
    const directory = logsDirectoryFor(root);
    const sink = createLogFileSink({ directory, maxBytes: 40, keep: 2 });

    sink.write(line('A'));
    sink.write(line('B'));
    sink.write(line('C'));
    sink.write(line('D'));

    // 四行、留两份：A 已经被删，剩下 D（当前）/ C（1）/ B（2）。
    expect(fs.readFileSync(sink.filePath, 'utf8')).toContain('D');
    expect(fs.readFileSync(rotatedLogPath(directory, 1), 'utf8')).toContain('C');
    expect(fs.readFileSync(rotatedLogPath(directory, 2), 'utf8')).toContain('B');
    expect(fs.existsSync(rotatedLogPath(directory, 3))).toBe(false);
  });

  it('单行就超过上限时照写，不进入「每次写都轮转」的死循环', () => {
    // 阈值 10 字节、一行 200 字节。若没有 `bytesWritten > 0` 那一半，
    // 每写一行都会先把上一行轮转掉，文件里永远只剩最后一行 —— 日志反而全丢。
    const directory = logsDirectoryFor(root);
    const sink = createLogFileSink({ directory, maxBytes: 10, keep: 1 });

    const huge = 'y'.repeat(200);
    sink.write(`${huge}-1`);
    sink.write(`${huge}-2`);

    expect(fs.readFileSync(sink.filePath, 'utf8')).toContain('-2');
    expect(fs.readFileSync(rotatedLogPath(directory, 1), 'utf8')).toContain('-1');
  });

  it('默认保留 3 份', () => {
    expect(LOG_FILE_KEEP).toBe(3);
  });
});

describe('落盘器 · 写不进去时降级', () => {
  it('目录位置被一个文件占住时：返回 false、置 broken、只报一次错', () => {
    // 造一个「同名文件挡在目录位上」的现场。真实世界里对应的是磁盘满或权限被改。
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory', 'utf8');

    const onError = vi.fn();
    const sink = createLogFileSink({ directory: blocked, onError });

    expect(sink.write('第一条')).toBe(false);
    expect(sink.broken).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);

    // 第二次连 try 都不进 —— 一个坏目录不该让每次 logWarn 都去摸一次盘。
    expect(sink.write('第二条')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
