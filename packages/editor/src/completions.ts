import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

/**
 * `/` 片段面板。
 *
 * ## 面板里有两类条目，来源不同
 *
 * - **内容级模板**（`markdownSnippets`）：块公式 / 行内公式 / wikilink / 链接 / 图片。
 *   它们**没有对应的命令** —— 「插入一对 `$`」不是一种块类型，也没有第二条入口。
 *   两条链接模板是刻意留着的：`format.insert-link` 的写法由 `files.linkFormat` 决定，
 *   想临时换一种写法就得有一处能直接写模板。
 * - **命令级动作**（`SlashCommandEntry`，由宿主注入）：标题 / 列表 / 引用 / 代码块 /
 *   表格 / 分割线。这些**本来就有命令**（菜单栏的「格式」菜单与命令面板走同一批），
 *   所以面板不自己抄一份清单 —— 加一个块级动作只改注册表，这里自动多一项。
 *
 * ## 命令级条目的 `apply` 是「删掉 `/查询`，再跑命令」
 *
 * 不把模板串插进正文，是因为那样等于把「块级动作」这件事写第二遍：菜单点一下得到
 * `## 标题`、`/h2` 打出来也得到 `## 标题`，两处只要有一处改了，另一处就开始漂。
 * 删掉查询串之后光标落在行首，命令看到的就是「用户在这条空行上要一个 H2」。
 *
 * 代价是**两条事务**（删除 + 命令），因而也是两个 undo 步：会话的撤销栈按事务记，
 * 不做 userEvent 分组。两个步进都是有意义的状态（「撤销这次格式」→「撤销我打的 `/h1`」），
 * 不值得为它换一条绕过命令的实现。
 *
 * ## 匹配用的是触发词，不是标签
 *
 * 标签是**译文**（中文界面下是「标题 1」），所以 `h1` 这种触发词必须单独带一份，
 * 否则中文界面里 `/h1` 什么也找不到。触发词按英文单词给（`h1` / `heading 1` /
 * `ul` / `bullet`），与界面语言无关 —— 与设置搜索的别名表是同一条理由。
 */

export interface MarkdownSnippetDef {
  label: string;
  template: string;
  detail?: string;
  info?: string;
  type?: string;
  boost?: number;
}

export const markdownSnippets: MarkdownSnippetDef[] = [
  {
    label: '$$ Block Math',
    template: '$$\n${formula}\n$$',
    detail: 'Display math block',
    type: 'snippet',
    boost: 8
  },
  {
    label: '$ Inline Math',
    template: '$${formula}$ ',
    detail: 'Inline math expression',
    type: 'snippet',
    boost: 7
  },
  {
    label: '[[ Wikilink',
    template: '[[${page}]]',
    detail: 'Internal wiki page link',
    type: 'snippet',
    boost: 8
  },
  {
    label: '[] Markdown Link',
    template: '[${text}](${url})',
    detail: 'Hyperlink',
    type: 'snippet',
    boost: 6
  },
  {
    label: '![] Image',
    template: '![${alt}](${url})',
    detail: 'Image reference',
    type: 'snippet',
    boost: 5
  }
];

/**
 * 一条命令级动作。**清单由宿主投影，编辑器不生成** —— 宿主才知道注册表里有什么。
 *
 * `commandId` 同时是「这条条目属于哪个动作」的凭据：面板里的每一项与菜单栏、
 * 命令面板指向的是同一个 id，判据因此可以断言「三处指的是同一批命令」。
 */
export interface SlashCommandEntry {
  commandId: string;
  /**
   * 触发词（不含 `/`），第一个是主词、会显示在右侧。
   *
   * 多个是必要的：`h1` 是顺手打的，`heading 1` 是记得住名字的人打的，两个都得能命中。
   */
  tokens: readonly string[];
  /** 面板里显示的标签，用命令自己的译文。 */
  label: string;
}

/**
 * 宿主注入的入口。
 *
 * `run` 收到的 `from` / `to` 是用户敲下的那段 `/查询` —— 宿主负责先删掉它再执行命令，
 * 否则 `/h1` 会留在正文里变成 `# /h1`。
 */
export interface SlashCommandHost {
  entries(): readonly SlashCommandEntry[];
  run(view: EditorView, commandId: string, from: number, to: number): void;
}

/** 匹配用的一对（触发词与补全项）。`filter: false` 下 CodeMirror 不再自己过滤。 */
interface SlashOption {
  tokens: readonly string[];
  completion: Completion;
}

function buildOptions(host: SlashCommandHost | undefined): SlashOption[] {
  const commands: SlashOption[] = (host?.entries() ?? []).map((entry) => ({
    tokens: entry.tokens,
    completion: {
      label: entry.label,
      detail: `/${entry.tokens[0] ?? ''}`,
      type: 'keyword',
      apply: (view, _completion, from, to) => host!.run(view, entry.commandId, from, to)
    }
  }));

  const snippets: SlashOption[] = markdownSnippets.map((def) => ({
    // 模板的标签本身就是英文（`$$ Block Math`），直接拿它当触发词 —— 它不长，也没有译文。
    tokens: [def.label.toLowerCase()],
    completion: snippetCompletion(def.template, {
      label: def.label,
      detail: def.detail,
      info: def.info,
      type: def.type ?? 'snippet',
      boost: def.boost
    })
  }));

  // 命令在前：块级动作是 `/` 面板的主要用途，模板是补充。
  return [...commands, ...snippets];
}

/**
 * Markdown 模板补全源（slash 命令风格）。
 *
 * 只在输入 `/` 或显式触发（Ctrl-Space）时给出条目，与 Markra 的 slash 菜单一致。
 * 之前的实现在输入 `|`、`#`、`>` 或普通单词（如 "table"、"code"）时也会弹窗，
 * 而补全面板会抢占 Enter → 用户想换行却插入整段模板（表格逐行输入因此无法完成）。
 */
export function createMarkdownCompletionSource(
  host?: SlashCommandHost
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    // 保持宽匹配：CodeMirror 的「按输入激活」依赖输入序列能匹配出查询串，
    // 若这里只匹配 `/...`，输入 slash 命令时面板根本不会打开。
    const word = context.matchBefore(/[\w#>[|!$/-]+/);

    if (!word) {
      if (!context.explicit) return null;
      return { from: context.pos, options: buildOptions(host).map((option) => option.completion) };
    }

    // 只有 slash 命令（或显式触发）才给出条目
    if (!word.text.startsWith('/')) return null;

    const query = word.text.slice(1).toLowerCase();

    const matched = buildOptions(host).filter((option) => {
      if (!query) return true;
      if (option.tokens.some((token) => token.includes(query))) return true;
      return option.completion.label.toLowerCase().includes(query);
    });

    if (matched.length === 0) {
      return null;
    }

    return {
      from: word.from,
      options: matched.map((option) => option.completion),
      // 过滤已在上面完成；若交给 CodeMirror 的默认过滤，它会拿带 `/` 的原始文本去匹配标签
      // （'/t' 匹配不上 '| Table'），面板会被清空。
      filter: false
    };
  };
}
