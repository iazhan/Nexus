import { type Language, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import {
  javascriptLanguage,
  typescriptLanguage,
  jsxLanguage,
  tsxLanguage
} from '@codemirror/lang-javascript';
import { htmlLanguage } from '@codemirror/lang-html';
import { cssLanguage } from '@codemirror/lang-css';
import { pythonLanguage } from '@codemirror/lang-python';
import { jsonLanguage } from '@codemirror/lang-json';
import { markdownLanguage } from '@codemirror/lang-markdown';

export interface CodeLanguageOption {
  label: string;
  value: string;
}

/**
 * 语言下拉框预设项，覆盖 35+ 种主流语言。
 */
export const DEFAULT_CODE_LANGUAGES: CodeLanguageOption[] = [
  { label: 'Plain Text', value: '' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'HTML', value: 'html' },
  { label: 'CSS', value: 'css' },
  { label: 'Python', value: 'python' },
  { label: 'JSON', value: 'json' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'C', value: 'c' },
  { label: 'C++', value: 'cpp' },
  { label: 'C#', value: 'csharp' },
  { label: 'Rust', value: 'rust' },
  { label: 'Go', value: 'go' },
  { label: 'Java', value: 'java' },
  { label: 'Kotlin', value: 'kotlin' },
  { label: 'Scala', value: 'scala' },
  { label: 'Swift', value: 'swift' },
  { label: 'Dart', value: 'dart' },
  { label: 'PHP', value: 'php' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'Perl', value: 'perl' },
  { label: 'Lua', value: 'lua' },
  { label: 'R', value: 'r' },
  { label: 'SQL', value: 'sql' },
  { label: 'Shell', value: 'shell' },
  { label: 'PowerShell', value: 'powershell' },
  { label: 'Docker', value: 'dockerfile' },
  { label: 'YAML', value: 'yaml' },
  { label: 'TOML', value: 'toml' },
  { label: 'INI', value: 'ini' },
  { label: 'HTTP', value: 'http' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'Diff', value: 'diff' },
  { label: 'XML', value: 'xml' },
  { label: 'Vue', value: 'vue' }
];

/**
 * 统一语言别名归一化映射。
 *
 * 覆盖作者手写围栏信息串的常见写法（大小写由 normalizeLanguage 统一处理），
 * 例如 `C#`、`c++`、`Objective-C`、`dockerfile`、`sh`、`bash` 等。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  htm: 'html',
  html5: 'html',
  xhtml: 'html',
  py: 'python',
  py3: 'python',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  mkd: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shellscript: 'shell',
  yml: 'yaml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cplusplus: 'cpp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  objc: 'objective-c',
  'obj-c': 'objective-c',
  ps1: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  patch: 'diff',
  gql: 'graphql'
};

/**
 * 规范化语言标识符
 */
export function normalizeLanguage(info: string): string {
  const lower = info.trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

/**
 * Returns a Language or LanguageDescription for code block parsing in Markdown.
 *
 * Synchronous core languages (TS, JS, HTML, CSS, Python, JSON, Markdown) return their
 * native Language directly for instantaneous highlighting with zero latency.
 *
 * All other 100+ languages from `@codemirror/language-data` return LanguageDescription
 * for on-demand asynchronous loading via dynamic imports.
 */
export function getCodeLanguage(info: string): Language | LanguageDescription | null {
  const lang = normalizeLanguage(info);
  switch (lang) {
    case 'typescript':
      return typescriptLanguage;
    case 'javascript':
      return javascriptLanguage;
    case 'tsx':
      return tsxLanguage;
    case 'jsx':
      return jsxLanguage;
    case 'html':
      return htmlLanguage;
    case 'css':
      return cssLanguage;
    case 'python':
      return pythonLanguage;
    case 'json':
      return jsonLanguage;
    case 'markdown':
      return markdownLanguage;
    default:
      return (
        LanguageDescription.matchLanguageName(languages, lang, true) ??
        LanguageDescription.matchLanguageName(languages, info.trim(), true)
      );
  }
}

/**
 * 检查语言是否可被 CodeMirror 语法系统识别。
 */
export function isLanguageSupported(info: string | undefined): boolean {
  if (!info) return false;
  return getCodeLanguage(info) !== null;
}

/**
 * 确保指定语言的解析器已加载完成（对于 language-data 中的异步语言包）。
 */
export async function ensureLanguageLoaded(info: string): Promise<void> {
  const lang = normalizeLanguage(info);
  const desc =
    LanguageDescription.matchLanguageName(languages, lang, true) ??
    LanguageDescription.matchLanguageName(languages, info.trim(), true);
  if (desc && !desc.support) {
    await desc.load();
  }
}

