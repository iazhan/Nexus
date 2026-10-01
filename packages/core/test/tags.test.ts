import { describe, it, expect } from 'vitest';
import {
  scanTags,
  extractTags,
  extractFrontmatterTags,
  extractDocumentTags
} from '../src/index.js';

/** 简写：只要标签名。 */
const names = (source: string) => extractTags(source);

/** 简写：只要标签在源码里的区间，`[from, to)`。 */
const spans = (source: string) => scanTags(source).map((match) => [match.from, match.to]);

describe('scanTags：位置', () => {
  it('`from` 指向 `#`，`to` 指向标签名末尾（不含末尾标点）', () => {
    //            0123 4567
    const source = '这是 #dma 相关。';
    expect(scanTags(source)).toEqual([{ tag: 'dma', from: 3, to: 7 }]);
  });

  it('末尾标点不计入标签区间', () => {
    //  0         1
    //  0123456789012345
    // '见 #dma，还有。'
    expect(spans('见 #dma，还有。')).toEqual([[2, 6]]);
  });

  it('同一个标签出现几次就返回几条', () => {
    expect(names('#a 与 #a')).toEqual(['a']);
    expect(scanTags('#a 与 #a')).toHaveLength(2);
  });
});

describe('extractTags：语法', () => {
  it('提取正文标签', () => {
    expect(names('这是 #dma 相关。')).toEqual(['dma']);
  });

  it('归一化：转小写', () => {
    expect(names('#DMA')).toEqual(['dma']);
  });

  it('去重（大小写归一后相同）', () => {
    expect(names('#a 与 #A')).toEqual(['a']);
  });

  it('ATX 标题不是标签 —— `#` 后面有空格', () => {
    expect(names('# 一级标题')).toEqual([]);
    expect(names('## 二级标题')).toEqual([]);
  });

  it('URL 片段不是标签 —— `#` 前面不是空白', () => {
    expect(names('见 https://example.com/page#anchor')).toEqual([]);
  });

  it('行首的标签能识别', () => {
    expect(names('#dma 开头的行')).toEqual(['dma']);
  });

  it('去掉粘在末尾的标点', () => {
    expect(names('见 #dma，还有 #ethercat.')).toEqual(['dma', 'ethercat']);
  });

  it('支持中文标签', () => {
    expect(names('#电机控制')).toEqual(['电机控制']);
  });

  it('支持路径式标签', () => {
    expect(names('#项目/nexus')).toEqual(['项目/nexus']);
  });

  it('没有标签时返回空数组', () => {
    expect(names('普通文本，没有标签。')).toEqual([]);
  });
});

describe('extractTags：纯数字不是标签', () => {
  it('编号引用不收 —— 这条规则存在的理由', () => {
    expect(names('见 issue #123')).toEqual([]);
    expect(names('第 #3 章')).toEqual([]);
    expect(names('#2026 年计划')).toEqual([]);
  });

  it('含字母或连字符的照样收 —— `#1984` 无效但 `#y1984` 有效', () => {
    expect(names('#y1984')).toEqual(['y1984']);
    expect(names('#dma123')).toEqual(['dma123']);
    expect(names('#123abc')).toEqual(['123abc']);
    expect(names('#2026-08')).toEqual(['2026-08']);
  });

  it('中文标签不受影响', () => {
    expect(names('#电机控制')).toEqual(['电机控制']);
  });

  it('与代码块判据叠加：代码里的 `#123` 本来就不收', () => {
    expect(names(['```c', '#123', '```', '#dma'].join('\n'))).toEqual(['dma']);
  });
});

describe('extractTags：代码里的 `#` 不是标签', () => {
  it('围栏代码块整块跳过', () => {
    const source = ['```c', '#include <stdio.h>', '#define MAX 8', '```', '#real'].join('\n');
    expect(names(source)).toEqual(['real']);
  });

  it('波浪号围栏同样跳过', () => {
    const source = ['~~~sh', '# 这是一行注释', '~~~', '#real'].join('\n');
    expect(names(source)).toEqual(['real']);
  });

  it('缩进不超过 3 空格的围栏也算围栏', () => {
    const source = ['   ```', '   #include <a.h>', '   ```', '#real'].join('\n');
    expect(names(source)).toEqual(['real']);
  });

  it('未闭合的围栏一直跳到文档末尾', () => {
    const source = ['```c', '#include <stdio.h>', '', '#still-code'].join('\n');
    expect(names(source)).toEqual([]);
  });

  it('围栏里更长的开标记不会被更短的闭标记关掉', () => {
    const source = ['````md', '```', '#inside', '```', '````', '#real'].join('\n');
    expect(names(source)).toEqual(['real']);
  });

  it('行内代码里的 `#` 不算标签', () => {
    expect(names('写 `#include` 就行')).toEqual([]);
  });

  it('行内代码外的标签照常识别', () => {
    expect(names('写 `#include` 得到 #c语言')).toEqual(['c语言']);
  });

  it('未闭合的反引号不是行内代码 —— 照常扫', () => {
    expect(names('这里 ` 没有闭合，后面 #dma')).toEqual(['dma']);
  });

  it('双反引号包裹的行内代码也跳过', () => {
    expect(names('``#not-a-tag`` 与 #yes')).toEqual(['yes']);
  });
});

describe('extractTags：frontmatter 块不算正文', () => {
  it('frontmatter 里的 `#标签` 不算正文标签', () => {
    const source = ['---', 'description: 关于 #dma 的说明', '---', '正文 #ethercat'].join('\n');
    expect(names(source)).toEqual(['ethercat']);
  });

  it('文件中间的 `---` 是分隔线，不是 frontmatter', () => {
    const source = ['正文 #dma', '', '---', '', '后面 #ethercat'].join('\n');
    expect(names(source)).toEqual(['dma', 'ethercat']);
  });
});

describe('extractFrontmatterTags', () => {
  it('流式数组', () => {
    expect(extractFrontmatterTags('---\ntags: [dma, ethercat]\n---\n正文')).toEqual([
      'dma',
      'ethercat'
    ]);
  });

  it('逗号分隔', () => {
    expect(extractFrontmatterTags('---\ntags: dma, ethercat\n---\n')).toEqual(['dma', 'ethercat']);
  });

  it('单个值', () => {
    expect(extractFrontmatterTags('---\ntags: dma\n---\n')).toEqual(['dma']);
  });

  it('块式列表', () => {
    const source = ['---', 'tags:', '  - dma', '  - ethercat', 'status: learning', '---', ''].join(
      '\n'
    );
    expect(extractFrontmatterTags(source)).toEqual(['dma', 'ethercat']);
  });

  it('块式列表遇到下一个键就停 —— 不会把整份 frontmatter 吃成标签', () => {
    const source = ['---', 'tags:', '  - dma', 'status: learning', 'title: 笔记', '---', ''].join(
      '\n'
    );
    expect(extractFrontmatterTags(source)).toEqual(['dma']);
  });

  it('单数 `tag:` 也认', () => {
    expect(extractFrontmatterTags('---\ntag: dma\n---\n')).toEqual(['dma']);
  });

  it('值里的前导 `#` 被去掉 —— 与正文标签同一口径', () => {
    expect(extractFrontmatterTags('---\ntags: [#dma, ethercat]\n---\n')).toEqual([
      'dma',
      'ethercat'
    ]);
  });

  it('大小写归一 —— 否则会与正文的 `#dma` 裂成两项', () => {
    expect(extractFrontmatterTags('---\ntags: [DMA]\n---\n')).toEqual(['dma']);
  });

  it('引号包裹的值去掉引号', () => {
    expect(extractFrontmatterTags('---\ntags: ["电机控制", \'ethercat\']\n---\n')).toEqual([
      '电机控制',
      'ethercat'
    ]);
  });

  it('没有 frontmatter 时返回空数组', () => {
    expect(extractFrontmatterTags('#dma\n正文')).toEqual([]);
  });

  it('frontmatter 里没有 tags 键时返回空数组', () => {
    expect(extractFrontmatterTags('---\ntitle: 笔记\n---\n')).toEqual([]);
  });

  it('没有闭合的 frontmatter 不认', () => {
    expect(extractFrontmatterTags('---\ntags: [dma]\n正文')).toEqual([]);
  });

  it('纯数字不收 —— 与正文**同一口径**，否则同一份文档里两处答案相反', () => {
    expect(extractFrontmatterTags('---\ntags: [1984]\n---\n')).toEqual([]);
    expect(extractFrontmatterTags('---\ntags: [1984, dma]\n---\n')).toEqual(['dma']);
    expect(extractFrontmatterTags('---\ntags:\n  - 2026\n  - y2026\n---\n')).toEqual(['y2026']);
  });
});

describe('extractDocumentTags', () => {
  it('正文与 frontmatter 合并去重', () => {
    const source = ['---', 'tags: [dma, 笔记]', '---', '正文 #ethercat 与 #dma'].join('\n');
    expect(extractDocumentTags(source)).toEqual(['ethercat', 'dma', '笔记']);
  });

  it('两处都没有时返回空数组', () => {
    expect(extractDocumentTags('普通文本。')).toEqual([]);
  });
});
