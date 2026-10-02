import { describe, it, expect } from 'vitest';
import {
  attachmentReferences,
  resolveWorkspacePath,
  rewriteAttachmentReferences,
  rewriteAttachmentTarget
} from '../src/index.js';

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

    it('带锚点的引用照样算引用 —— `#page=342` 是翻到第几页，不是另一个文件', () => {
      // 不切锚点的话这里会得到 `['stm32.pdf#page=342']`，于是「被引用附件」判据落空，
      // 那个 PDF 提取过的正文会被当成「没被引用」清掉 —— 症状是「明明引用了却搜不到」。
      expect(targets('见 [[stm32.pdf#page=342]]。')).toEqual(['stm32.pdf']);
      expect(targets('[[手册.pdf#第3章]]')).toEqual(['手册.pdf']);
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

/**
 * 附件引用的回写（批二）。
 *
 * 判定用 `resolveWorkspacePath()`（与索引期「这篇引用了哪些附件」同一个函数），
 * 变换只负责**把用户写目标的方式原样保留**：相对基准、尖括号、百分号编码、锚点、
 * 引号风格一个都不动，只换路径那一小段。
 *
 * 默认场景：源码是 `notes/dma.md`，所以 `assets/logo.png` 解析成 `notes/assets/logo.png`。
 */
describe('rewriteAttachmentTarget', () => {
  const source = 'notes/dma.md';
  const from = 'notes/assets/logo.png';
  const to = 'notes/assets/logo2.png';

  it('文档相对写法：只换文件名，前缀不动', () => {
    expect(rewriteAttachmentTarget('assets/logo.png', source, from, to)).toBe('assets/logo2.png');
  });

  it('显式的 `./` 保留 —— 改的是指向，不是排版', () => {
    expect(rewriteAttachmentTarget('./assets/logo.png', source, from, to)).toBe(
      './assets/logo2.png'
    );
  });

  it('相对基准是**文档所在目录**，跨目录时重新算', () => {
    const from2 = 'assets/logo.png';
    const to2 = 'assets/logo2.png';
    expect(rewriteAttachmentTarget('../assets/logo.png', source, from2, to2)).toBe(
      '../assets/logo2.png'
    );
  });

  it('前导 `/` 是工作区根，写法保留（不改成相对）', () => {
    expect(
      rewriteAttachmentTarget(
        '/assets/logo.png',
        source,
        'assets/logo.png',
        'assets/logo2.png'
      )
    ).toBe('/assets/logo2.png');
  });

  it('尖括号包裹原样保留', () => {
    expect(
      rewriteAttachmentTarget(
        '<assets/my logo.png>',
        source,
        'notes/assets/my logo.png',
        'notes/assets/my logo2.png'
      )
    ).toBe('<assets/my logo2.png>');
  });

  it('新名字带空格时**补上**尖括号（原来没包裹只是因为原来没空格）', () => {
    expect(rewriteAttachmentTarget('assets/logo.png', source, from, 'notes/assets/my logo.png')).toBe(
      '<assets/my logo.png>'
    );
  });

  it('原来是百分号编码的，新路径继续编码', () => {
    expect(
      rewriteAttachmentTarget(
        'assets/my%20logo.png',
        source,
        'notes/assets/my logo.png',
        'notes/assets/my logo2.png'
      )
    ).toBe('assets/my%20logo2.png');
  });

  it('锚点与查询串原样，且 `#` / `?` 混用时从最先出现的那个开始', () => {
    expect(
      rewriteAttachmentTarget(
        'attachments/stm32.pdf#page=342',
        source,
        'notes/attachments/stm32.pdf',
        'notes/attachments/stm32-v2.pdf'
      )
    ).toBe('attachments/stm32-v2.pdf#page=342');
    expect(rewriteAttachmentTarget('assets/logo.png?v=2', source, from, to)).toBe(
      'assets/logo2.png?v=2'
    );
    expect(rewriteAttachmentTarget('assets/logo.png?v=2#x', source, from, to)).toBe(
      'assets/logo2.png?v=2#x'
    );
  });

  it('指向的不是被改名的那个就返回 null', () => {
    expect(rewriteAttachmentTarget('assets/other.png', source, from, to)).toBeNull();
    expect(rewriteAttachmentTarget('https://example.com/logo.png', source, from, to)).toBeNull();
    expect(rewriteAttachmentTarget('data:image/png;base64,AA', source, from, to)).toBeNull();
  });

  it('大小写不敏感（Windows 上就是同一个文件），新写法用磁盘上的真名', () => {
    expect(rewriteAttachmentTarget('Assets/Logo.png', source, from, to)).toBe('assets/logo2.png');
  });
});

describe('rewriteAttachmentReferences', () => {
  const source = 'notes/dma.md';
  const from = 'notes/assets/logo.png';
  const to = 'notes/assets/logo2.png';

  /** 简写：只要改写后的正文。 */
  function rewrite(text: string): string {
    return rewriteAttachmentReferences(text, source, from, to).text;
  }

  it('只换目标那一小段，其余一个字节都不动', () => {
    const text = '# 标题\n\n![原理图](assets/logo.png "说明")\n\n正文。\n';
    expect(rewrite(text)).toBe('# 标题\n\n![原理图](assets/logo2.png "说明")\n\n正文。\n');
  });

  it('Markdown 链接与 HTML img 都改', () => {
    expect(rewrite('[下载](assets/logo.png)')).toBe('[下载](assets/logo2.png)');
    expect(rewrite('<img src="assets/logo.png" width="200">')).toBe(
      '<img src="assets/logo2.png" width="200">'
    );
    expect(rewrite("<img src='assets/logo.png'>")).toBe("<img src='assets/logo2.png'>");
    expect(rewrite('<img src=assets/logo.png width=100>')).toBe(
      '<img src=assets/logo2.png width=100>'
    );
  });

  it('一行里多处、以及重复引用，全都改', () => {
    expect(rewrite('![a](assets/logo.png) 和 ![b](assets/logo.png)')).toBe(
      '![a](assets/logo2.png) 和 ![b](assets/logo2.png)'
    );
  });

  it('从后往前替换 —— 前面改了不会让后面记录的偏移失效', () => {
    // 第一处改完会**变长**（`a.png` → `very-long-name.png`），若从前往后替换，
    // 第二处的偏移就会错位。这个用例专门盯这个。
    const text = '![x](<a.png>) ![y](a.png)';
    const result = rewriteAttachmentReferences(
      text,
      source,
      'notes/a.png',
      'notes/very-long-name.png'
    );
    expect(result.text).toBe('![x](<very-long-name.png>) ![y](very-long-name.png)');
    expect(result.count).toBe(2);
  });

  it('指向别处的引用不动，返回值与入参同一个字符串', () => {
    const text = '![a](assets/other.png) 见 https://example.com/logo.png';
    const result = rewriteAttachmentReferences(text, source, from, to);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('没有引用要改时 text 与入参同一个引用（调用方可以拿 === 判断）', () => {
    const text = '没有引用的正文';
    expect(rewriteAttachmentReferences(text, source, from, to).text).toBe(text);
  });

  it('wikilink 形式的附件引用不在这里处理（走 rewriteWikiLinkTarget）', () => {
    const text = '见 [[assets/logo.png]]。';
    expect(rewriteAttachmentReferences(text, source, from, to).count).toBe(0);
  });
});
