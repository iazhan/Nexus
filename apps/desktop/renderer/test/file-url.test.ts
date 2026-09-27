// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { toFileUrl } from '../src/viewer/image/file-url.js';

/**
 * 路径 → `file://` URL。
 *
 * 这个转换是图片 Viewer 唯一可能悄悄坏掉的地方：URL 错了，浏览器只会
 * 「加载不出来」，界面上看不出是转义问题还是文件真的没了。
 * 所以这里逐例钉死输出，而不是断言「包含 file://」这类松判据。
 *
 * 表里的期望值是**逐字节**对着 Node 的 `pathToFileURL` 校过的
 * （`node -e "pathToFileURL(...)"`）；`+ ~ & =` 那几个字符本文档刻意
 * 转义得更保守，见 `toFileUrl` 的注释 —— 解码后是同一个文件名，不影响正确性。
 */
describe('toFileUrl', () => {
  it.each([
    ['反斜杠路径', 'D:\\Notes\\a.png', 'file:///D:/Notes/a.png'],
    ['正斜杠路径 —— 两种写法必须等价', 'D:/Notes/a.png', 'file:///D:/Notes/a.png'],
    ['混合分隔符', 'D:\\Notes/sub/a.png', 'file:///D:/Notes/sub/a.png'],
    ['空格', 'D:\\Notes\\a b.png', 'file:///D:/Notes/a%20b.png'],
    ['中文目录与文件名', 'D:\\笔记\\报告.png', 'file:///D:/%E7%AC%94%E8%AE%B0/%E6%8A%A5%E5%91%8A.png'],
    ['`#` —— 不转义会被当成锚点', 'D:\\a#1.png', 'file:///D:/a%231.png'],
    ['`?` —— 不转义会被当成查询串', 'D:\\a?b.png', 'file:///D:/a%3Fb.png'],
    ['`%` —— 二次转义，不能重复解码', 'D:\\a%20b.png', 'file:///D:/a%2520b.png'],
    ['小写盘符保持原样', 'd:\\a.png', 'file:///d:/a.png'],
    ['大写扩展名不被动过', 'D:\\a\\b\\c.PNG', 'file:///D:/a/b/c.PNG'],
    ['盘符根', 'D:\\', 'file:///D:/'],
    ['多段组合', 'D:\\图 1#?.png', 'file:///D:/%E5%9B%BE%201%23%3F.png']
  ])('%s', (_label, input, expected) => {
    expect(toFileUrl(input)).toBe(expected);
  });

  it('盘符的冒号不能转义 —— 转成 %3A 会被浏览器当成相对路径', () => {
    // 反例：直觉上「逐段 encodeURIComponent」会顺手把 `D:` 变成 `D%3A`
    expect(encodeURIComponent('D:')).toBe('D%3A');

    const url = toFileUrl('D:\\a.png');
    expect(url).not.toContain('%3A');
    expect(url.startsWith('file:///D:/')).toBe(true);
  });

  it('分隔用的斜杠不能被转义 —— 否则整条路径塌成一段文件名', () => {
    // 反例：整串 encodeURIComponent 会把 `/` 变成 `%2F`
    expect(encodeURIComponent('a/b.png')).toBe('a%2Fb.png');

    const url = toFileUrl('D:\\dir\\a.png');
    expect(url).not.toContain('%2F');
    expect(url).toBe('file:///D:/dir/a.png');
  });

  it('不用 encodeURI —— 它不转义 `#` 与 `?`，而这两个在 Windows 文件名里合法', () => {
    const original = 'file:///D:/图#1.png';
    // 反例：encodeURI 会原样留下 `#`
    expect(encodeURI(original)).toContain('#');

    const url = toFileUrl('D:\\图#1.png');
    expect(url).not.toContain('#');
    expect(url).toContain('%23');
  });
});
