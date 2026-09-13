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
 * Autocompletion source for Markdown syntax, snippets, and structures.
 */
export function markdownCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const word = context.matchBefore(/[/a-zA-Z0-9_#>[|!$-]+/);

  if (!word && !context.explicit) {
    return null;
  }

  const query = (word?.text ?? '').toLowerCase();

  // If user typed a slash command e.g. /h1, /code, /math
  const cleanQuery = query.startsWith('/') ? query.slice(1) : query;

  const matched = markdownCompletions.filter((comp) => {
    if (!cleanQuery) return true;
    const label = comp.label.toLowerCase();
    const detail = comp.detail?.toLowerCase() ?? '';
    return label.includes(cleanQuery) || detail.includes(cleanQuery);
  });

  if (matched.length === 0) {
    return null;
  }

  return {
    from: word ? word.from : context.pos,
    options: matched
  };
}
