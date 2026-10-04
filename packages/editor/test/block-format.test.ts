import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@nexus/markdown';
import {
  applyChangesToSource,
  createBlockFormatTransaction,
  readBlockFormatState,
  type BlockFormatKind,
  type MarkdownSelection
} from '../src/index.js';

/**
 * 块级改型（P1-1）。
 *
 * 四条判据逐条覆盖：① 断言**变换后的 source 字符串**（不是「变了」）；
 * ② **反面** —— 已经是该类型的块再执行一次要正确回退；③ 代码块 / 表格里必须拒绝；
 * ④ **CRLF fixture**（按行加前缀的正则在 CRLF 上会整条失配）。
 *
 * 断言字符串而不是「事务非空」，是因为「有没有改错地方」只有逐字比才看得出来：
 * 一个把 `## ` 插到行尾的实现在「事务非空」上完全合格。
 */

/** 光标在 `offset`，无选区。 */
function caret(offset: number): MarkdownSelection {
  return { anchor: offset, head: offset };
}

function range(from: number, to: number): MarkdownSelection {
  return { anchor: from, head: to };
}

/** 跑一次改型，返回新 source。`null`（拒绝 / 无事可做）原样返回。 */
function run(
  source: string,
  selection: MarkdownSelection,
  kind: BlockFormatKind
): string | null {
  const tx = createBlockFormatTransaction(source, selection, kind);
  return tx ? applyChangesToSource(source, tx.changes) : null;
}

describe('块级改型：变换后的 source（判据 ①）', () => {
  it('段落 → 标题 2', () => {
    expect(run('正文', caret(0), 'heading-2')).toBe('## 正文');
  });

  it('标题 1 → 标题 2：级别被替换，不是叠加', () => {
    expect(run('# 标题', caret(0), 'heading-2')).toBe('## 标题');
  });

  it('列表项 → 标题 1：叶块类型互斥，列表标记被换掉而不是留在标题里', () => {
    expect(run('- 项目', caret(0), 'heading-1')).toBe('# 项目');
  });

  it('缩进是层级不是块类型，改型保留它', () => {
    expect(run('  - 项目', caret(2), 'heading-1')).toBe('  # 项目');
  });

  it('段落 → 引用', () => {
    expect(run('正文', caret(0), 'quote')).toBe('> 正文');
  });

  it('引用是容器：加在列表外面，不是替换掉列表', () => {
    expect(run('- 项目', caret(0), 'quote')).toBe('> - 项目');
  });

  it('引用里的标题去前缀时引用留着 —— 去掉的是叶块类型，不是容器', () => {
    expect(run('> ## 标题', caret(3), 'paragraph')).toBe('> 标题');
  });

  it('段落 → 无序列表', () => {
    expect(run('正文', caret(0), 'bullet-list')).toBe('- 正文');
  });

  it('多行 → 有序列表：编号逐行递增，不是每行都写 1.', () => {
    expect(run('a\nb\nc', range(0, 5), 'ordered-list')).toBe('1. a\n2. b\n3. c');
  });

  it('无序列表 → 任务列表', () => {
    expect(run('- 项目', caret(0), 'task-list')).toBe('- [ ] 项目');
  });

  it('多行混选：各自的前缀都被换成目标标记，缩进与引用各自保留', () => {
    expect(run('> a\n- b', range(0, 7), 'bullet-list')).toBe('> - a\n- b');
  });

  it('选中行末尾那个换行不算下一行 —— 拖到行尾不该把下一行也改了', () => {
    expect(run('a\nb\nc', range(0, 2), 'bullet-list')).toBe('- a\nb\nc');
  });
});

describe('块级改型：回退与幂等（判据 ②）', () => {
  it('标题 2 再点标题 2 → 回段落', () => {
    expect(run('## 标题', caret(0), 'heading-2')).toBe('标题');
  });

  it('两次标题 2 回到原样', () => {
    const once = run('标题', caret(0), 'heading-2')!;
    expect(run(once, caret(0), 'heading-2')).toBe('标题');
  });

  it('无序列表再点无序列表 → 回段落', () => {
    expect(run('- 项目', caret(0), 'bullet-list')).toBe('项目');
  });

  it('任务列表再点任务列表 → 回段落', () => {
    expect(run('- [ ] 项目', caret(0), 'task-list')).toBe('项目');
  });

  it('引用再点引用 → 去掉引用（容器加一次减一次，可逆）', () => {
    expect(run('> 引用', caret(2), 'quote')).toBe('引用');
  });

  it('已经是段落时点段落：**不产生事务** —— 空事务会白占一格 undo 栈', () => {
    expect(run('正文', caret(0), 'paragraph')).toBeNull();
  });

  it('引用里的列表点引用 → 去掉的是引用那一层，列表还在', () => {
    expect(run('> - 项目', caret(3), 'quote')).toBe('- 项目');
  });

  it('换标题级别不是「回退」：H2 上点 H3 得到 H3', () => {
    expect(run('## 标题', caret(0), 'heading-3')).toBe('### 标题');
  });
});

describe('块级改型：不可改型的容器（判据 ③）', () => {
  const FENCED = '```\ncode\n```\n';
  const TABLE = '| a | b |\n| --- | --- |\n| c | d |\n';

  it('代码块里拒绝改型', () => {
    expect(run(FENCED, caret(5), 'heading-2')).toBeNull();
  });

  it('代码块里的空行同样拒绝 —— 空行也是容器的一部分', () => {
    expect(run('```\na\n\nb\n```\n', caret(6), 'bullet-list')).toBeNull();
  });

  it('表格里拒绝改型', () => {
    expect(run(TABLE, caret(3), 'bullet-list')).toBeNull();
  });

  it('引用里嵌的代码块一样拒绝（容器判定走 AST，不看缩进）', () => {
    expect(run('> ```\n> code\n> ```\n', caret(6), 'heading-2')).toBeNull();
  });

  it('反面：行内原子**不挡** —— 段落里的行内代码是内容不是容器', () => {
    expect(run('段落里有 `x`', caret(0), 'heading-2')).toBe('## 段落里有 `x`');
  });

  it('反面：表格**后面**那一行照常改型', () => {
    expect(run(TABLE + '正文', caret(TABLE.length), 'heading-2')).toBe(
      TABLE + '## 正文'
    );
  });
});

describe('块级改型：代码块的包与拆', () => {
  it('包住选中行', () => {
    expect(run('a\nb', range(0, 3), 'code-block')).toBe('```\na\nb\n```');
  });

  it('空行上包：围栏之间不留空行', () => {
    expect(run('a\n', caret(2), 'code-block')).toBe('a\n```\n```');
  });

  it('空行上包：光标落在开栏行末尾（围栏**里面**），不是闭栏之后', () => {
    // 两行围栏是一次插入的，`finalize` 的 assoc=1 映射会把光标推到插入内容末尾 ——
    // 而下一步是敲代码，光标得在围栏里。`/` 面板打「代码块」走的正是这条路。
    const tx = createBlockFormatTransaction('a\n', caret(2), 'code-block')!;

    expect(applyChangesToSource('a\n', tx.changes)).toBe('a\n```\n```');
    expect(tx.selection).toEqual({ anchor: 5, head: 5 });
  });

  it('在代码块里再点一次 → 拆掉围栏，内容逐字留下', () => {
    // 行尾那个换行留着：它在拆之前就属于文档的行结构，不是围栏的一部分。
    expect(run('```\ncode\n```\n', caret(5), 'code-block')).toBe('code\n');
  });

  it('包 → 拆 是往返：结果与原文逐字相同', () => {
    const wrapped = run('a\nb', range(0, 3), 'code-block')!;
    expect(wrapped).toBe('```\na\nb\n```');
    // 拆的时候光标要落在内容里（围栏里），否则落在围栏行上不会触发拆。
    expect(run(wrapped, caret(5), 'code-block')).toBe('a\nb');
  });

  it('反面：未闭合的围栏**拆不掉** —— 找不到哪里算结束，删错就是把正文吃进去', () => {
    expect(run('```\ncode\n', caret(5), 'code-block')).toBeNull();
  });

  it('反面：表格里不给包 —— 包成代码块会把表格退化成字面文本', () => {
    expect(run('| a | b |\n| --- | --- |\n| c | d |\n', caret(3), 'code-block')).toBeNull();
  });
});

describe('块级改型：插入动作（表格 / 分割线）', () => {
  it('分割线落在当前行之后，不切开行内文本', () => {
    expect(run('hello', caret(2), 'horizontal-rule')).toBe('hello\n---');
  });

  it('分割线：当前行是空行时不补前置换行', () => {
    expect(run('a\n\nb', caret(2), 'horizontal-rule')).toBe('a\n---\nb');
  });

  it('表格骨架落在当前行之后', () => {
    expect(run('a', caret(0), 'table')).toBe('a\n|  |  |\n| --- | --- |\n|  |  |');
  });

  it('插入的表格骨架能被解析回来 —— 写出来的得能读回去', () => {
    const source = run('a', caret(0), 'table')!;
    const table = parseMarkdown(source).root.children.find((node) => node.type === 'table');
    expect(table).toBeDefined();
    expect(table?.type === 'table' && table.headers.length).toBe(2);
  });

  it('插入后光标落在插入内容里（表格落在第一个表头格子）', () => {
    const tx = createBlockFormatTransaction('a', caret(0), 'table')!;
    expect(tx.selection?.head).toBe(4);
  });

  it('分割线插在文档最后一行的末尾时不需要额外换行', () => {
    expect(run('a\nb', caret(3), 'horizontal-rule')).toBe('a\nb\n---');
  });
});

describe('块级改型：CRLF（判据 ④）', () => {
  it('第二行加标题前缀，第一行逐字不动', () => {
    expect(run('## a\r\nb', caret(6), 'heading-2')).toBe('## a\r\n## b');
  });

  it('多行加引用：换行仍是 CRLF，没有被换成 LF', () => {
    expect(run('## a\r\nb', range(0, 7), 'quote')).toBe('> ## a\r\n> b');
  });

  it('多行有序列表：换行仍是 CRLF', () => {
    expect(run('a\r\nb', range(0, 4), 'ordered-list')).toBe('1. a\r\n2. b');
  });

  it('CRLF 文档里包代码块：围栏用 CRLF 隔开', () => {
    expect(run('a\r\nb', range(0, 4), 'code-block')).toBe('```\r\na\r\nb\r\n```');
  });

  it('CRLF 文档里拆围栏：内容逐字留下，不残留孤立的 \\r', () => {
    expect(run('```\r\ncode\r\n```\r\n', caret(6), 'code-block')).toBe('code\r\n');
  });

  it('CRLF 文档里插分割线', () => {
    expect(run('a\r\nb', caret(0), 'horizontal-rule')).toBe('a\r\n---\r\nb');
  });

  it('CRLF 文档里取块级状态：行边界不吃 \\r', () => {
    expect(readBlockFormatState('## a\r\n- b', caret(6)).leaf).toBe('bullet-list');
  });
});

describe('块级状态查询（菜单的 ✓ / 禁用依据）', () => {
  it('段落', () => {
    expect(readBlockFormatState('正文', caret(0))).toEqual({
      leaf: 'paragraph',
      quoted: false,
      editable: true,
      inCodeBlock: false
    });
  });

  it('标题 3', () => {
    expect(readBlockFormatState('### 标题', caret(4)).leaf).toBe('heading-3');
  });

  it('引用与叶块类型**同时**成立：`> ## 标题` 上两项都该亮', () => {
    expect(readBlockFormatState('> ## 标题', caret(5))).toEqual({
      leaf: 'heading-2',
      quoted: true,
      editable: true,
      inCodeBlock: false
    });
  });

  it('多行类型不一致 → `leaf` 为 `null`（一个 ✓ 都不亮，也不该假装是段落）', () => {
    expect(readBlockFormatState('## a\n- b', range(0, 7)).leaf).toBeNull();
  });

  it('代码块里：不可改型，但「代码块」那一项仍有效（它是拆围栏）', () => {
    expect(readBlockFormatState('```\ncode\n```\n', caret(5))).toEqual({
      leaf: null,
      quoted: false,
      editable: false,
      inCodeBlock: true
    });
  });

  it('表格里：不可改型，且连「代码块」也无效', () => {
    expect(readBlockFormatState('| a | b |\n| --- | --- |\n| c | d |\n', caret(3))).toEqual({
      leaf: null,
      quoted: false,
      editable: false,
      inCodeBlock: false
    });
  });

  it('**与事务同一个判据**：状态说「已经是它」，事务就必须是回退', () => {
    const source = '## 标题';
    expect(readBlockFormatState(source, caret(0)).leaf).toBe('heading-2');
    expect(run(source, caret(0), 'heading-2')).toBe('标题');
  });
});
