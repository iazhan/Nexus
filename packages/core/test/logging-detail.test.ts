import { describe, it, expect } from 'vitest';
import { formatLogDetail } from '../src/logging/detail.js';

describe('日志附加信息 · 转成一段文本', () => {
  it('没有东西可写时返回 undefined —— 由调用方决定不画那一段', () => {
    // `''` 也算「没有」：一个空字符串画出来是一段空白，读起来像取数失败。
    expect(formatLogDetail(undefined)).toBeUndefined();
    expect(formatLogDetail(null)).toBeUndefined();
    expect(formatLogDetail('')).toBeUndefined();
  });

  it('字符串原样返回，不加引号', () => {
    // `console.error('失败:', 'EACCES')` 该得到 `EACCES`，不是 `"EACCES"`。
    expect(formatLogDetail('EACCES')).toBe('EACCES');
    expect(formatLogDetail('磁盘已满')).toBe('磁盘已满');
  });

  it('Error 取堆栈 —— 走 JSON 的话它只剩 `{}`', () => {
    // 这一条是整条通道存在的理由：Electron 的结构化克隆不保留原型，
    // 一个 Error 送过去就是 `{}`，最该记下来的堆栈反而没了。
    const error = new Error('磁盘满');
    const detail = formatLogDetail(error);

    expect(detail).toContain('磁盘满');
    expect(detail).toContain('Error');
  });

  it('没有堆栈的 Error 退回 `Name: message`，不返回空', () => {
    const error = new Error('没有堆栈');
    delete error.stack;

    expect(formatLogDetail(error)).toBe('Error: 没有堆栈');
  });

  it('普通对象走 JSON', () => {
    expect(formatLogDetail({ path: '/a', count: 2 })).toBe('{"path":"/a","count":2}');
  });

  it('循环引用不抛 —— 抛在这里等于丢掉整条日志', () => {
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;

    // 退化成 `[object Object]` 也比没有强，而抛出去会让调用方那条日志整个消失。
    expect(() => formatLogDetail(circular)).not.toThrow();
    expect(formatLogDetail(circular)).toBeTypeOf('string');
  });

  it('数字与布尔转成文本', () => {
    expect(formatLogDetail(0)).toBe('0');
    expect(formatLogDetail(false)).toBe('false');
  });
});
