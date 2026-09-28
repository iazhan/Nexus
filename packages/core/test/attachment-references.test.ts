import { describe, it, expect } from 'vitest';
import { attachmentReferences, resolveWorkspacePath } from '../src/index.js';

/** 简写：只关心解析出的路径。 */
function paths(source: string, sourceRelativePath = 'notes/dma.md'): readonly string[] {
  return attachmentReferences(source, sourceRelativePath).paths;
}

/** 简写：只关心 wikilink 目标。 */
function targets(source: string, sourceRelativePath = 'notes/dma.md'): readonly string[] {
  return attachmentReferences(source, sourceRelativePath).wikilinkTargets;
}

describe('resolveWorkspacePath', () => {
  it('以所在目录为基准解析相对路径', () => {
    expect(resolveWorkspacePath('notes/dma.md', 'logo.png')).toBe('notes/logo.png');
    expect(resolveWorkspacePath('notes/dma.md', './logo.png')).toBe('notes/logo.png');
    expect(resolveWorkspacePath('notes/dma.md', '../assets/logo.png')).toBe('assets/logo.png');
    expect(resolveWorkspacePath('notes/dma.md', 'deep/../../a.png')).toBe('a.png');
  });

  it('根目录下的文档，相对路径就是工作区相对路径', () => {
    expect(resolveWorkspacePath('index.md', 'assets/a.png')).toBe('assets/a.png');
  });

  it('前导 `/` 是工作区根，不是文件系统根', () => {
    expect(resolveWorkspacePath('notes/deep/dma.md', '/assets/a.png')).toBe('assets/a.png');
  });

  it('反斜杠一律当分隔符', () => {
    expect(resolveWorkspacePath('notes/dma.md', 'img\\a.png')).toBe('notes/img/a.png');
  });

  it('切掉锚点与查询串', () => {
    // 蓝图 §11.4 的页码引用格式
    expect(resolveWorkspacePath('index.md', 'attachments/stm32.pdf#page=342')).toBe(
      'attachments/stm32.pdf'
    );
    expect(resolveWorkspacePath('index.md', 'a.png?v=2')).toBe('a.png');
    expect(resolveWorkspacePath('index.md', 'a.png#x?v=2')).toBe('a.png');
  });

  it('解码百分号转义', () => {
    expect(resolveWorkspacePath('index.md', 'my%20file.png')).toBe('my file.png');
    expect(resolveWorkspacePath('index.md', '%E5%8E%9F%E7%90%86%E5%9B%BE.png')).toBe(
      '原理图.png'
    );
  });

  it('逃出工作区根的一律丢弃，不钳到根上', () => {
    expect(resolveWorkspacePath('index.md', '../outside.png')).toBeNull();
    expect(resolveWorkspacePath('notes/dma.md', '../../outside.png')).toBeNull();
    expect(resolveWorkspacePath('notes/dma.md', 'a/../../../outside.png')).toBeNull();
    // 逐级退回**刚好**回到根、再往下的，是合法的 —— 别把「退到根」误判成逃逸
    expect(resolveWorkspacePath('notes/dma.md', 'a/../../outside.png')).toBe('outside.png');
  });

  it('编码过的逃逸同样被拦下（先解码再切段）', () => {
    // `%2e%2e%2f` 就是 `../`。若先切段再解码，逃逸检查看不见它 ——
    // 那正是「边界校验被绕过」的经典形态。
    expect(resolveWorkspacePath('index.md', '%2e%2e%2foutside.png')).toBeNull();
    expect(resolveWorkspacePath('notes/dma.md', '%2e%2e%2f%2e%2e%2foutside.png')).toBeNull();
  });

  it('带 scheme 的一律不是工作区文件', () => {
    expect(resolveWorkspacePath('index.md', 'https://example.com/a.png')).toBeNull();
    expect(resolveWorkspacePath('index.md', 'http://example.com/a.png')).toBeNull();
    expect(resolveWorkspacePath('index.md', 'data:image/png;base64,AAAA')).toBeNull();
    expect(resolveWorkspacePath('index.md', 'mailto:me@example.com')).toBeNull();
    expect(resolveWorkspacePath('index.md', 'nexus-asset://ws/?path=a.png')).toBeNull();
    expect(resolveWorkspacePath('index.md', '//host/a.png')).toBeNull();
  });

  it('空目标与纯锚点返回 null', () => {
    expect(resolveWorkspacePath('index.md', '')).toBeNull();
    expect(resolveWorkspacePath('index.md', '   ')).toBeNull();
    expect(resolveWorkspacePath('index.md', '#section')).toBeNull();
    expect(resolveWorkspacePath('index.md', '/')).toBeNull();
    expect(resolveWorkspacePath('index.md', './')).toBeNull();
  });

  it('非法的百分号序列不炸，当普通文件名处理', () => {
    expect(resolveWorkspacePath('index.md', '100%.png')).toBe('100%.png');
  });
});

describe('attachmentReferences', () => {
  describe('图片与链接', () => {
    it('收集图片引用', () => {
      expect(paths('![原理图](assets/原理图.png)')).toEqual(['notes/assets/原理图.png']);
    });

    it('链接也算引用 —— 蓝图 §11.4 的页码引用就是这个形状', () => {
      expect(paths('[STM32F4 Reference Manual](attachments/stm32.pdf#page=342)')).toEqual([
        'notes/attachments/stm32.pdf'
      ]);
    });

    it('alt 为空、带 title、尖括号包裹都认', () => {
      expect(paths('![](a.png)')).toEqual(['notes/a.png']);
      expect(paths('[x](a.png "标题")')).toEqual(['notes/a.png']);
      expect(paths('[x](<my file.png>)')).toEqual(['notes/my file.png']);
    });

    it('同一行多个引用都收', () => {
      expect(paths('![a](a.png) 和 ![b](b.pdf)')).toEqual(['notes/a.png', 'notes/b.pdf']);
    });

    it('只认白名单里的附件，Markdown 与非白名单扩展名都跳过', () => {
      expect(paths('[笔记](other.md)')).toEqual([]);
      expect(paths('[笔记](other.markdown)')).toEqual([]);
      expect(paths('[文本](notes.txt)')).toEqual([]);
      expect(paths('[没有扩展名](readme)')).toEqual([]);
    });

    it('外部链接、data URI 都跳过', () => {
      expect(paths('![x](https://example.com/a.png)')).toEqual([]);
      expect(paths('![x](data:image/png;base64,AAAA)')).toEqual([]);
    });
  });

  describe('HTML <img>', () => {
    it('双引号、单引号、不加引号三种写法都认', () => {
      expect(paths('<img src="a.png">')).toEqual(['notes/a.png']);
      expect(paths("<img src='b.png' alt='x'>")).toEqual(['notes/b.png']);
      expect(paths('<img src=c.png width=100>')).toEqual(['notes/c.png']);
    });

    it('大小写不敏感', () => {
      expect(paths('<IMG SRC="a.png">')).toEqual(['notes/a.png']);
    });

    it('没有 src 的 img 不炸也不产出', () => {
      expect(paths('<img alt="x">')).toEqual([]);
    });
  });

  describe('wikilink', () => {
    it('带扩展名的目标原样保留', () => {
      expect(targets('[[stm32.pdf]]')).toEqual(['stm32.pdf']);
    });

    it('别名只取目标', () => {
      expect(targets('[[stm32.pdf|参考手册]]')).toEqual(['stm32.pdf']);
    });

    it('短名原样保留（匹配交给候选集）', () => {
      expect(targets('[[stm32]]')).toEqual(['stm32']);
    });

    it('去 `.md`、转小写 —— 与 links 表同一口径', () => {
      expect(targets('[[Notes/DMA.MD]]')).toEqual(['notes/dma']);
    });

    it('Obsidian 的嵌入写法 `![[...]]` 也算引用', () => {
      expect(targets('![[原理图.png]]')).toEqual(['原理图.png']);
    });

    it('去重', () => {
      expect(targets('[[a.pdf]] 与 [[a.pdf]] 与 [[A.PDF]]')).toEqual(['a.pdf']);
    });

    it('wikilink 不进 paths（名字式引用没有目录信息）', () => {
      expect(paths('[[stm32.pdf]]')).toEqual([]);
    });
  });

  describe('整体行为', () => {
    it('paths 与 wikilinkTargets 去重', () => {
      const refs = attachmentReferences('![a](a.png)\n![a](a.png)', 'index.md');
      expect(refs.paths).toEqual(['a.png']);
    });

    it('代码块里的引用也会被收进来（偏召回，与 extractWikiLinkTargets 同一条取舍）', () => {
      const source = '```md\n![x](a.png)\n```';
      expect(paths(source)).toEqual(['notes/a.png']);
    });

    it('引用一个不存在的文件是合法的 —— 这里只解析，不校验存在性', () => {
      expect(paths('![x](还没建的图.png)')).toEqual(['notes/还没建的图.png']);
    });

    it('空源码返回两个空数组', () => {
      expect(attachmentReferences('', 'index.md')).toEqual({ paths: [], wikilinkTargets: [] });
    });

    it('一篇文档里的多个引用形态混在一起，顺序即源码顺序', () => {
      const source = [
        '![封面](assets/cover.png)',
        '见 [[stm32.pdf]]。',
        '<img src="assets/内部.png">',
        '[手册](assets/manual.docx)'
      ].join('\n\n');

      const refs = attachmentReferences(source, 'notes/index.md');
      expect(refs.paths).toEqual([
        'notes/assets/cover.png',
        'notes/assets/内部.png',
        'notes/assets/manual.docx'
      ]);
      expect(refs.wikilinkTargets).toEqual(['stm32.pdf']);
    });
  });
});
