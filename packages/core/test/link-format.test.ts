import { describe, it, expect } from 'vitest';
import {
  LINK_FORMAT_DEFAULT,
  LINK_FORMAT_MARKDOWN,
  LINK_FORMAT_WIKILINK,
  LINK_FORMAT_WIKILINK_PATH,
  buildDocumentLink,
  documentTypeForPath,
  parseLinkFormat,
  resolveWikiLink,
  type IndexedDocument,
  type LinkFormat,
  type LinkTargetDocument
} from '../src/index.js';

/** 与 `wikilink.test.ts` 同形：类型从路径推导，不手写死，免得与白名单脱节。 */
function doc(relativePath: string): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none'
  };
}

function target(relativePath: string): LinkTargetDocument {
  const { path, relativePath: rel } = doc(relativePath);
  return { path, relativePath: rel };
}

/** 当前文档的绝对路径 —— Markdown 档要靠它算相对路径。 */
const CURRENT = '/vault/notes/dma.md';

/** 产出成功时的文本；失败直接让测试炸，省得每处都写 `if (!result.ok)`。 */
function textOf(...args: Parameters<typeof buildDocumentLink>): string {
  const result = buildDocumentLink(...args);
  if (!result.ok) throw new Error(`应当能写出来，却失败了：${result.reason}`);
  return result.text;
}

describe('buildDocumentLink：三档写法', () => {
  it('wikilink 档只写名字，Markdown 去掉扩展名', () => {
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK, CURRENT)).toBe('[[dma]]');
    // 根目录下的文档也一样 —— `documentTitleOf` 那条「前导点不算扩展名」的规则要跟着走
    expect(textOf(target('.gitignore'), LINK_FORMAT_WIKILINK, CURRENT)).toBe('[[.gitignore]]');
  });

  it('wikilink 档的附件写全名 —— 短名会被同名 .md 抢走', () => {
    // `[[stm32]]` 在 `stm32.md` 也存在时会归 `.md`（候选顺序是契约，见 wikilink.ts）。
    // 所以附件必须写全名，这是唯一能精确指向它的写法。
    expect(textOf(target('assets/logo.png'), LINK_FORMAT_WIKILINK, CURRENT)).toBe('[[logo.png]]');
  });

  it('wikilink-path 档写工作区根相对路径，与当前文档在哪无关', () => {
    const expected = '[[notes/dma]]';
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK_PATH, CURRENT)).toBe(expected);
    // 换一个当前文档，wikilink 的写法**不变** —— 它的路径基准是工作区根
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK_PATH, '/vault/a/b.md')).toBe(expected);
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK_PATH, null)).toBe(expected);
  });

  it('wikilink-path 档的附件保留扩展名', () => {
    expect(textOf(target('assets/logo.png'), LINK_FORMAT_WIKILINK_PATH, CURRENT)).toBe(
      '[[assets/logo.png]]'
    );
  });

  it('Markdown 档写相对当前文档的路径，带扩展名', () => {
    // 同目录：只写文件名
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe('[dma](dma.md)');
    // 上一级再进别的目录
    expect(textOf(target('archive/dma.md'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe(
      '[dma](../archive/dma.md)'
    );
    // 附件保留全名
    expect(textOf(target('assets/logo.png'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe(
      '[logo.png](../assets/logo.png)'
    );
  });

  it('Markdown 档的路径基准是**当前文档**，换个位置写法就变', () => {
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, '/vault/notes/dma.md')).toBe(
      '[dma](dma.md)'
    );
    expect(textOf(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, '/vault/archive/x.md')).toBe(
      '[dma](../notes/dma.md)'
    );
  });
});

describe('buildDocumentLink：反向验证（写出来的必须能读回来）', () => {
  /**
   * 这一组才是这个函数存在的意义：它和 `resolveWikiLink` 是一对逆运算，
   * 单测只断言字面量的话，两边各自漂了也没人发现。
   */
  it.each([
    ['只写名字', LINK_FORMAT_WIKILINK, 'notes/dma.md'],
    ['写路径', LINK_FORMAT_WIKILINK_PATH, 'notes/dma.md'],
    ['根目录下的文档', LINK_FORMAT_WIKILINK, 'root.md'],
    ['写路径的根目录文档', LINK_FORMAT_WIKILINK_PATH, 'root.md'],
    ['附件', LINK_FORMAT_WIKILINK, 'assets/logo.png'],
    ['写路径的附件', LINK_FORMAT_WIKILINK_PATH, 'assets/logo.png']
  ])('wikilink 两档：%s 的产物喂回 resolveWikiLink 落到同一篇', (_label, format, relativePath) => {
    const text = textOf(target(relativePath), format as LinkFormat, CURRENT);
    expect(text.startsWith('[[')).toBe(true);
    expect(text.endsWith(']]')).toBe(true);

    const inner = text.slice(2, -2);
    // 文档集里**每个名字都唯一** —— 名字档在同名共存时本来就该 ambiguous，
    // 那种情形由下面那条专条负责，混进来只会让这一组红得没有信息量。
    const documents = [doc('root.md'), doc('notes/dma.md'), doc('assets/logo.png')];
    const resolution = resolveWikiLink(inner, documents);

    expect(resolution.status).toBe('resolved');
    expect(resolution.document?.relativePath).toBe(relativePath);
  });

  it('wikilink 只写名字那一档在同名文档存在时会 ambiguous —— 这正是路径档存在的理由', () => {
    const text = textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK, CURRENT);
    const documents = [doc('notes/dma.md'), doc('archive/dma.md')];
    expect(resolveWikiLink(text.slice(2, -2), documents).status).toBe('ambiguous');

    // 换成路径档就唯一了
    const pathText = textOf(target('notes/dma.md'), LINK_FORMAT_WIKILINK_PATH, CURRENT);
    const pathResolution = resolveWikiLink(pathText.slice(2, -2), documents);
    expect(pathResolution.status).toBe('resolved');
    expect(pathResolution.document?.relativePath).toBe('notes/dma.md');
  });
});

describe('buildDocumentLink：写不出来的情形', () => {
  it('Markdown 档没有打开的文档 → no-current-document', () => {
    // 「相对谁」没有基准。返回失败而不是瞎猜一个目录 —— 猜出来的链接指向别处且不报错。
    expect(buildDocumentLink(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, null)).toEqual({
      ok: false,
      reason: 'no-current-document'
    });
  });

  it('Markdown 档的当前文档没有目录（裸文件名）也算没有基准', () => {
    expect(buildDocumentLink(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, 'dma.md')).toEqual({
      ok: false,
      reason: 'no-current-document'
    });
  });

  it('跨卷 → not-in-workspace', () => {
    expect(buildDocumentLink(target('notes/dma.md'), LINK_FORMAT_MARKDOWN, 'D:/other/dma.md')).toEqual({
      ok: false,
      reason: 'not-in-workspace'
    });
  });

  it.each([']', '|', '#', '['])('wikilink 两档：名字含 %s 时放弃', (char) => {
    // wikilink 语法没有转义机制 —— 写出来就是一段坏掉的正文。宁可让链接断掉（可见的
    // not-found），也不写坏语法。与批二 rewriteWikiLinkTarget 同一条纪律。
    const name = `dm${char}a.md`;
    expect(buildDocumentLink(target(name), LINK_FORMAT_WIKILINK, CURRENT)).toEqual({
      ok: false,
      reason: 'unescapable-name'
    });
    expect(buildDocumentLink(target(name), LINK_FORMAT_WIKILINK_PATH, CURRENT)).toEqual({
      ok: false,
      reason: 'unescapable-name'
    });
  });

  it('Markdown 档**不**因为这些字符失败 —— 它有转义机制', () => {
    // 只转义**文字**里的方括号（照 formatDocumentCitation）。目标里的 `]` 不需要转义：
    // CommonMark 的 destination 允许方括号，只有文字里的会提前结束链接。
    expect(textOf(target('dm]a.md'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe('[dm\\]a](../dm]a.md)');
  });

  it('Markdown 档：路径含空格或括号时用 <...> 包裹', () => {
    // 空格是 formatDocumentCitation 已经处理过的那种；括号是这里多判的 ——
    // 不成对的括号会让链接当场坏掉，而文件名里出现单个括号太容易了。
    expect(textOf(target('my notes/dma.md'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe(
      '[dma](<../my notes/dma.md>)'
    );
    expect(textOf(target('my (old) notes/dma.md'), LINK_FORMAT_MARKDOWN, CURRENT)).toBe(
      '[dma](<../my (old) notes/dma.md>)'
    );
  });
});

describe('parseLinkFormat', () => {
  it('三个合法取值原样返回', () => {
    for (const format of [LINK_FORMAT_WIKILINK, LINK_FORMAT_WIKILINK_PATH, LINK_FORMAT_MARKDOWN]) {
      expect(parseLinkFormat(format)).toBe(format);
    }
  });

  it('认不出的值回落默认档', () => {
    // 值要拿去查表，所以必须收窄 —— 与 parseDeleteMode / parseHistoryRetention 同一条。
    // 方向与「会删数据的项」相反是刻意的：这一项只是写法，回落到默认就是最保守的落点。
    expect(parseLinkFormat('absolute')).toBe(LINK_FORMAT_DEFAULT);
    expect(parseLinkFormat('')).toBe(LINK_FORMAT_DEFAULT);
    expect(parseLinkFormat(null)).toBe(LINK_FORMAT_DEFAULT);
    expect(parseLinkFormat(undefined)).toBe(LINK_FORMAT_DEFAULT);
  });

  it('默认档是「只写名字」—— 等于加这一项之前的观感', () => {
    expect(LINK_FORMAT_DEFAULT).toBe(LINK_FORMAT_WIKILINK);
  });
});
