import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';

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
    label: '# Heading 1',
    template: '# ${title}',
    detail: 'Level 1 Heading',
    type: 'text',
    boost: 10
  },
  {
    label: '## Heading 2',
    template: '## ${title}',
    detail: 'Level 2 Heading',
    type: 'text',
    boost: 9
  },
  {
    label: '### Heading 3',
    template: '### ${title}',
    detail: 'Level 3 Heading',
    type: 'text',
    boost: 8
  },
  {
    label: '#### Heading 4',
    template: '#### ${title}',
    detail: 'Level 4 Heading',
    type: 'text',
    boost: 7
  },
  {
    label: '- Bullet List',
    template: '- ${item}',
    detail: 'Unordered list item',
    type: 'text',
    boost: 6
  },
  {
    label: '1. Numbered List',
    template: '1. ${item}',
    detail: 'Ordered list item',
    type: 'text',
    boost: 5
  },
  {
    label: '- [ ] Task List',
    template: '- [ ] ${task}',
    detail: 'Task checkbox item',
    type: 'text',
    boost: 5
  },
  {
    label: '> Blockquote',
    template: '> ${quote}',
    detail: 'Blockquote line',
    type: 'text',
    boost: 4
  },
  {
    label: '``` Code Block',
    template: '```${lang}\n${code}\n```',
    detail: 'Fenced code block',
    type: 'snippet',
    boost: 10
  },
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
  },
  {
    label: '| Table',
    template: '| Header 1 | Header 2 |\n| -------- | -------- |\n| Cell 1   | Cell 2   |',
    detail: 'Markdown table with headers',
    type: 'snippet',
    boost: 7
  }
];

export const markdownCompletions: Completion[] = markdownSnippets.map((def) =>
  snippetCompletion(def.template, {
    label: def.label,
    detail: def.detail,
    info: def.info,
    type: def.type ?? 'snippet',
    boost: def.boost
  })
);

/**
 * Markdown 模板补全源（slash 命令风格）。
 *
 * 只在输入 `/` 或显式触发（Ctrl-Space）时给出模板，与 Markra 的 slash 菜单一致。
 * 之前的实现在输入 `|`、`#`、`>` 或普通单词（如 "table"、"code"）时也会弹窗，
 * 而补全面板会抢占 Enter → 用户想换行却插入整段模板（表格逐行输入因此无法完成）。
 */
export function markdownCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  // 保持宽匹配：CodeMirror 的「按输入激活」依赖输入序列能匹配出查询串，
  // 若这里只匹配 `/...`，输入 slash 命令时面板根本不会打开。
  const word = context.matchBefore(/[\w#>[|!$/-]+/);

  if (!word) {
    if (!context.explicit) return null;
    return { from: context.pos, options: markdownCompletions };
  }

  // 只有 slash 命令（或显式触发）才给出模板
  if (!word.text.startsWith('/')) return null;

  const query = word.text.slice(1).toLowerCase();

  const matched = markdownCompletions.filter((comp) => {
    if (!query) return true;
    const label = comp.label.toLowerCase();
    const detail = comp.detail?.toLowerCase() ?? '';
    return label.includes(query) || detail.includes(query);
  });

  if (matched.length === 0) {
    return null;
  }

  return {
    from: word.from,
    options: matched,
    // 过滤已在上面按去掉 `/` 的查询串完成；若交给 CodeMirror 的默认过滤，
    // 它会拿带 `/` 的原始文本去匹配标签（'/t' 匹配不上 '| Table'），面板会被清空。
    filter: false
  };
}
