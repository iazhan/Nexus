import { describe, it, expect } from 'vitest';
import { extractOutline } from '../src/workspace/outline.js';

/**
 * 大纲提取。
 *
 * 重点在**误判**：代码块里的 `# 注释` 不是标题，这是最容易错的一条。
 */
describe('大纲提取', () => {
  it('提取 ATX 标题及其层级', () => {
    const headings = extractOutline('# 一级\n\n## 二级\n\n### 三级\n');
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, '一级'],
      [2, '二级'],
      [3, '三级']
    ]);
  });

  it('offset 指向该行的起始位置，可用于跳转', () => {
    const source = '# 第一行标题\n\n正文\n\n## 第二行标题\n';
    const headings = extractOutline(source);

    expect(source.slice(headings[0]!.offset).startsWith('# 第一行标题')).toBe(true);
    expect(source.slice(headings[1]!.offset).startsWith('## 第二行标题')).toBe(true);
  });

  it('围栏代码块里的 # 不是标题', () => {
    const source = [
      '# 真标题',
      '',
      '```python',
      '# 这是注释，不是标题',
      '## 也不是',
      '```',
      '',
      '## 后面的真标题'
    ].join('\n');

    expect(extractOutline(source).map((h) => h.text)).toEqual(['真标题', '后面的真标题']);
  });

  it('波浪线围栏同样生效，且两种围栏不会互相闭合', () => {
    const source = [
      '# 标题',
      '~~~',
      '# 在波浪线围栏里，不是标题',
      '```',
      '# 还在波浪线围栏里（``` 关不掉 ~~~）',
      '~~~',
      '## 出来了'
    ].join('\n');

    expect(extractOutline(source).map((h) => h.text)).toEqual(['标题', '出来了']);
  });

  it('未闭合的围栏会一直屏蔽到文末', () => {
    const source = ['# 标题', '```', '# 之后的都不算'].join('\n');
    expect(extractOutline(source).map((h) => h.text)).toEqual(['标题']);
  });

  it('CRLF 文档的标题文本不带 \\r', () => {
    const source = '# 标题一\r\n\r\n## 标题二\r\n';
    const headings = extractOutline(source);

    expect(headings.map((h) => h.text)).toEqual(['标题一', '标题二']);
    expect(headings[1]!.text).not.toContain('\r');
  });

  it('去掉结尾的闭合 #', () => {
    expect(extractOutline('## 标题 ##').map((h) => h.text)).toEqual(['标题']);
  });

  it('跳过空标题与超过 6 级的 #', () => {
    const source = ['#', '#   ', '####### 七个井号不是标题', '# 正常'].join('\n');
    expect(extractOutline(source).map((h) => h.text)).toEqual(['正常']);
  });

  it('没有标题时返回空数组', () => {
    expect(extractOutline('只有正文。\n\n还有一段。\n')).toEqual([]);
  });

  it('缩进的标题也能识别（Markdown 允许最多 3 个空格）', () => {
    expect(extractOutline('   ## 缩进的标题').map((h) => h.text)).toEqual(['缩进的标题']);
  });
});
