import type { DocumentType } from './types.js';

/**
 * 扩展名白名单 —— **只有这里登记的扩展名才会被当作可打开的文档**。
 *
 * 刻意用白名单而不是黑名单：黑名单每接一种新格式就要补一次，漏一个的后果
 * 是「用户以为打不开、其实能打开」或更糟的「不该打开的被打开了」。
 * 同样的教训在扫描跳过规则上已经踩过一次（逐个列举 node_modules / .git /
 * .obsidian …，结果漏了别的笔记工具留下的 .marking / .nestnote）——
 * 那次改成了 `name.startsWith('.')` 的前缀判定，这里一开始就用白名单。
 */
const EXTENSION_TO_TYPE: Readonly<Record<string, DocumentType>> = Object.freeze({
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  // svg 放在 <img> 里不会执行脚本，可以当图片显示；
  // 但它不是位图，将来若要缩放/旋转需要单独处理。
  '.svg': 'image'
});

/**
 * 提取小写扩展名（含前导点）。
 *
 * dotfile（`.gitignore`）返回空串 —— `lastDot <= 0` 那一条就是为了它，
 * 否则 `.gitignore` 会被当成扩展名是 `.gitignore` 的文件。
 */
export function getPathExtension(filePath: string): string {
  const filename = filePath.split(/[/\\]/).pop() ?? '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return filename.slice(lastDot).toLowerCase();
}

/** 路径对应的文档类型；不在白名单里返回 `null`。 */
export function documentTypeForPath(filePath: string): DocumentType | null {
  return EXTENSION_TO_TYPE[getPathExtension(filePath)] ?? null;
}

/** 是否是 Markdown —— lightweight 模式的判据。 */
export function isMarkdownPath(filePath: string): boolean {
  return documentTypeForPath(filePath) === 'markdown';
}

/** 白名单里的全部扩展名，供「打开文件」对话框的过滤器使用。 */
export function supportedDocumentExtensions(): readonly string[] {
  return Object.freeze(Object.keys(EXTENSION_TO_TYPE));
}
