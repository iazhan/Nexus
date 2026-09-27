import { describe, expect, it } from 'vitest';
import {
  ASSET_HOST,
  ASSET_PATH_PARAM,
  ASSET_SCHEME,
  assetPathFromUrl,
  toAssetUrl
} from '../src/index.js';

/**
 * `nexus-asset://` 的 URL 契约。
 *
 * 这是 main（协议 handler）、renderer（图片与 PDF 的 `src`）与 editor（Markdown 内嵌
 * 图片的 `src`）**三方共用的编码器**，也是这条链路上唯一可能悄悄坏掉的地方：
 * URL 错了，界面上只会「一片空白」，看不出是转义问题还是文件真的没了。
 *
 * 所以钉的不是「包含 nexus-asset」这类松判据，而是**往返无损**：单侧断言字符串太脆
 * （改一次编码器要改整张表），而往返失败才是真正的 bug。
 *
 * 用例里的路径特征不是假想的 —— 取自真实工作区 `D:\Note\Note` 的 407 张图片：
 * **398 个含中文、316 个含空格、246 个含方括号 `[ ]`**。方括号是 Obsidian 的常见
 * 命名（`Pasted image [1].png`），任何「只处理 ASCII 路径」的实现都会挂。
 */
describe('toAssetUrl / assetPathFromUrl 往返', () => {
  /** 走一遍真实的解码路径：`URL` + `URLSearchParams`，与主进程 handler 完全一致。 */
  function roundTrip(absolutePath: string): string | null {
    return assetPathFromUrl(toAssetUrl(absolutePath));
  }

  it('形状固定为 nexus-asset://ws/?path=…', () => {
    expect(toAssetUrl('D:\\a.pdf')).toBe('nexus-asset://ws/?path=D%3A%2Fa.pdf');
  });

  it.each([
    ['普通路径', 'D:\\Notes\\a.pdf'],
    ['正斜杠写法 —— 必须与反斜杠得到同一个 URL', 'D:/Notes/a.pdf'],
    ['混合分隔符', 'D:\\Notes/sub/a.pdf'],
    ['空格', 'D:\\Notes\\a b.pdf'],
    ['中文目录与文件名', 'D:\\技术文档\\架构设计.pdf'],
    ['`#` —— 不转义会被当成锚点', 'D:\\a#1.pdf'],
    ['`?` —— 不转义会截断查询串', 'D:\\a?b.pdf'],
    ['`&` —— 不转义会切出第二个参数', 'D:\\a&b=c.pdf'],
    ['`=` —— 不转义会切坏键值', 'D:\\a=b.pdf'],
    ['`+` —— 字面 `+` 会被解码成空格，必须转成 %2B', 'D:\\a+b.pdf'],
    ['`%` —— 二次转义，不能重复解码', 'D:\\a%20b.pdf'],
    ['`[` `]` —— Obsidian 的常见命名，真实工作区里 246 个', 'D:\\Notes\\Pasted image [1].png'],
    ['小写盘符', 'd:\\a.pdf'],
    ['深目录', 'D:\\工作\\2026\\季度报告\\Q3 财务#终版.pdf']
  ])('往返无损：%s', (_label, input) => {
    expect(roundTrip(input)).toBe(input.replace(/\\/g, '/'));
  });

  it('真实工作区里最复杂的那种路径也往返无损', () => {
    // 中文 + 空格 + 方括号 + 5 层目录，取自 D:\Note\Note 的实际文件名
    const real =
      'D:\\Note\\Note\\学习笔记\\嵌入式软件\\笔记\\江协科技STM32--学习笔记 [汇总]\\assets\\0_1.png';
    expect(roundTrip(real)).toBe(real.replace(/\\/g, '/'));
    // 方括号必须被转义
    expect(toAssetUrl(real)).toContain('%5B');
    expect(toAssetUrl(real)).toContain('%5D');
  });

  it('两种分隔符写法必须得到逐字节相同的 URL', () => {
    // 否则索引来的 `D:\a.png` 与拖放来的 `D:/a.png` 会成为两个不同的资源地址，
    // 缓存与 Range 请求各自为政 —— 表现是「同一份 PDF 有时要重新加载」。
    expect(toAssetUrl('D:\\a.pdf')).toBe(toAssetUrl('D:/a.pdf'));
  });

  it('整串编码，不是按段 —— `/` 在这里只是数据', () => {
    const url = toAssetUrl('D:\\Notes\\a.pdf');
    // 按段编码会让 `/` 保持原样（手写 file:// 编码器必须那样做），这里的判据正好相反
    expect(url).toContain('%2F');
    expect(url.slice('nexus-asset://ws/?path='.length)).not.toContain('/');
  });

  it('`+` 必须转成 %2B —— 字面 `+` 在查询串里会被解码成空格', () => {
    // 反例：`URLSearchParams` 确实把字面 `+` 当空格
    expect(new URLSearchParams('path=a+b').get('path')).toBe('a b');

    const url = toAssetUrl('D:\\a+b.pdf');
    expect(url).toContain('%2B');
    expect(roundTrip('D:\\a+b.pdf')).toBe('D:/a+b.pdf');
  });

  it('不是 file:// —— 这条通道在 dev 下不工作（http 页面不能加载 file:// 子资源）', () => {
    // 这条断言看着像废话，但它钉住的是一个**被实测推翻过的决策**：
    // P3-06 时图片走 file://，dev 下全部打不开（Chromium 的本地资源策略，
    // CSP 管不了）。任何人想把这里改回 file:// 之前，先看本文件的文件头注释。
    expect(toAssetUrl('D:\\a.pdf')).not.toContain('file:');
  });
});

describe('assetPathFromUrl', () => {
  it('查询参数里的路径由 URLSearchParams 解码，盘符冒号与反斜杠原样还原', () => {
    // 反斜杠**原样返回**是刻意的：归一化是 FileService 的职责（`path.resolve`），
    // 协议层顺手「清理」路径只会让「谁改了路径」变成难查的意外。
    expect(assetPathFromUrl(toAssetUrl('D:\\notes\\a.pdf'))).toBe('D:/notes/a.pdf');
  });

  it('Windows 文件名里合法的 # 与 ? 不会被当成 URL 片段或查询起点', () => {
    expect(assetPathFromUrl(toAssetUrl('D:\\notes\\图#1.pdf'))).toBe('D:/notes/图#1.pdf');
    expect(assetPathFromUrl(toAssetUrl('D:\\notes\\a?b.pdf'))).toBe('D:/notes/a?b.pdf');
  });

  it('& = + 空格 中文 都能往返', () => {
    const weird = 'D:\\notes\\a&b=c+d 中文 空格.pdf';
    expect(assetPathFromUrl(toAssetUrl(weird))).toBe(weird.replace(/\\/g, '/'));
  });

  it('百分号本身也能往返（不会被二次解码）', () => {
    expect(assetPathFromUrl(toAssetUrl('D:\\notes\\100%.pdf'))).toBe('D:/notes/100%.pdf');
  });

  it('缺参数 / 空参数 / 非法 URL → null', () => {
    expect(assetPathFromUrl(`${ASSET_SCHEME}://${ASSET_HOST}/`)).toBeNull();
    expect(assetPathFromUrl(`${ASSET_SCHEME}://${ASSET_HOST}/?${ASSET_PATH_PARAM}=`)).toBeNull();
    expect(assetPathFromUrl('not a url')).toBeNull();
  });
});
