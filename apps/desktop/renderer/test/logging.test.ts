import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 在 `logging.ts` 求值**之前**把 `console.error` / `console.warn` 换成探针。
 *
 * `rawConsole` 是模块加载时 `bind` 出来的，所以之后再 `vi.spyOn(console, …)` 是没用的 ——
 * 接管函数手里攥着的还是最初那两个引用。`vi.hoisted` 是唯一能在 import 之前跑的地方。
 *
 * 顺带的好处：接管后的 `console.error` 不再往测试输出里写东西。
 */
const { rawError, rawWarn } = vi.hoisted(() => {
  const rawError = vi.fn();
  const rawWarn = vi.fn();
  console.error = rawError as unknown as typeof console.error;
  console.warn = rawWarn as unknown as typeof console.warn;
  return { rawError, rawWarn };
});

import {
  installRendererLogging,
  logDebug,
  logError,
  logInfo,
  logWarn,
  resetRendererLogging
} from '../src/logging.js';

/**
 * 渲染进程的日志出口。
 *
 * 判据取**桥收到了什么**，不取主进程最终写了什么 —— 那是主进程自己的事
 * （`apps/desktop/test/logger.test.ts`），两边分开测才不会互相掩盖。
 */

let writeLog: ReturnType<typeof vi.fn>;

/** 造一个带 `error` / `message` 的事件 —— happy-dom 的 `ErrorEvent` 构造签名不完全一致。 */
function dispatchError(detail: { error?: unknown; message?: string }): void {
  const event = new Event('error');
  Object.assign(event, detail);
  window.dispatchEvent(event);
}

function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection');
  Object.assign(event, { reason });
  window.dispatchEvent(event);
}

function lastEntry(): { level: string; message: string; detail?: string } {
  return writeLog.mock.calls.at(-1)?.[0] as { level: string; message: string };
}

beforeEach(() => {
  rawError.mockClear();
  rawWarn.mockClear();
  writeLog = vi.fn();
  (window as unknown as { nexus?: unknown }).nexus = { writeLog };
});

afterEach(() => {
  resetRendererLogging();
  delete (window as unknown as { nexus?: unknown }).nexus;
});

describe('渲染进程日志 · 显式出口', () => {
  it('四个级别各送各的', () => {
    logError('出错了');
    expect(lastEntry()).toMatchObject({ level: 'error', message: '出错了' });

    logWarn('小心');
    expect(lastEntry()).toMatchObject({ level: 'warn', message: '小心' });

    logInfo('记一笔');
    expect(lastEntry()).toMatchObject({ level: 'info', message: '记一笔' });

    logDebug('细节');
    expect(lastEntry()).toMatchObject({ level: 'debug', message: '细节' });
  });

  it('没有附加信息时不带 detail 字段 —— 不是一个空串', () => {
    logError('光一句话');
    expect(lastEntry()).not.toHaveProperty('detail');
  });

  it('Error 的堆栈跟着走 —— 只记一句 message 等于把现场丢了', () => {
    logError('保存失败', new Error('磁盘满'));

    const entry = lastEntry();
    expect(entry.detail).toContain('磁盘满');
    expect(entry.detail).toContain('Error');
  });

  it('桥不在时静默 —— 记日志失败绝不该反过来让调用方出错', () => {
    delete (window as unknown as { nexus?: unknown }).nexus;

    expect(() => logError('没人接')).not.toThrow();
    expect(() => logInfo('也没人接')).not.toThrow();
  });
});

describe('渲染进程日志 · 接管 console', () => {
  it('`console.error` 既照常输出，又转发一条 —— 少哪一半都不对', () => {
    installRendererLogging();

    console.error('Save failed:', new Error('EACCES'));

    // 一半：DevTools 里看到的东西与加这一层之前完全一样。
    expect(rawError).toHaveBeenCalledTimes(1);
    // 另一半：它进了日志。
    const entry = lastEntry();
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('Save failed:');
    expect(entry.detail).toContain('EACCES');
  });

  it('`console.warn` 同样被接管', () => {
    installRendererLogging();

    console.warn('Vim 扩展加载失败:', new Error('chunk 404'));

    expect(rawWarn).toHaveBeenCalledTimes(1);
    expect(lastEntry()).toMatchObject({ level: 'warn', message: 'Vim 扩展加载失败:' });
  });

  it('多个实参合成一条附加信息，不是丢掉后面的', () => {
    installRendererLogging();

    console.error('三个参数', '第一个', { 第二个: true });

    const entry = lastEntry();
    expect(entry.detail).toContain('第一个');
    expect(entry.detail).toContain('第二个');
  });

  it('第一个实参不是字符串时也照收，不丢这一条', () => {
    installRendererLogging();

    console.error(new Error('光一个错误对象'));

    expect(lastEntry().message).toContain('光一个错误对象');
  });

  it('**`console.log` / `console.info` / `console.debug` 不被接管** —— 量不可控，价值也低', () => {
    installRendererLogging();

    console.log('随手打的');
    console.info('也是');
    console.debug('还是');

    expect(writeLog).not.toHaveBeenCalled();
  });

  it('重复装是幂等的 —— 三个窗口跑同一份入口', () => {
    installRendererLogging();
    installRendererLogging();

    console.error('一次');

    // 装两次会让同一条消息被转发两遍。
    expect(writeLog).toHaveBeenCalledTimes(1);
  });
});

describe('渲染进程日志 · 未处理错误兜底', () => {
  it('未捕获的异常被记下来', () => {
    installRendererLogging();

    dispatchError({ error: new Error('渲染阶段炸了'), message: '渲染阶段炸了' });

    const entry = lastEntry();
    expect(entry.level).toBe('error');
    expect(entry.message).toContain('未捕获的异常');
    expect(entry.detail).toContain('渲染阶段炸了');
  });

  it('只有 message 没有 error 时也记 —— 不同宿主给的东西不一样', () => {
    installRendererLogging();

    dispatchError({ message: 'Script error.' });

    expect(lastEntry().detail).toContain('Script error.');
  });

  it('**资源加载失败不记** —— 那两个字段都是空的，记下来只会淹掉真正的崩溃', () => {
    installRendererLogging();

    dispatchError({});

    expect(writeLog).not.toHaveBeenCalled();
  });

  it('没接住的 Promise 拒绝被记下来', () => {
    installRendererLogging();

    dispatchRejection(new Error('忘了 catch'));

    const entry = lastEntry();
    expect(entry.message).toContain('未处理的 Promise 拒绝');
    expect(entry.detail).toContain('忘了 catch');
  });

  it('摘掉之后事件不再转发 —— 用例之间不该互相污染', () => {
    installRendererLogging();
    resetRendererLogging();

    dispatchError({ error: new Error('不该被记') });

    expect(writeLog).not.toHaveBeenCalled();
  });
});
