import { ProcessorRegistry, type DocumentProcessor } from '@nexus/core';
import { extractPdfText } from './pdf-text.js';
import { extractDocxText } from './docx-text.js';

/**
 * 主进程侧的处理器**装配**（Phase 3 / P3-10）。
 *
 * 装配与注册表分开：注册表（`@nexus/core` 的 `ProcessorRegistry`）是零依赖**契约**，
 * main / 将来的 renderer 都能用；两个处理器各自依赖一个重包（pdfjs legacy、mammoth），
 * **只能**住在声明了这些依赖的包里。塞进同一个模块就是让契约层依赖具体实现 ——
 * 那正是 `@nexus/core` 到现在 `dependencies` 为空的价值（`phase-3-plan.md` §10.2 决策 2）。
 *
 * 工厂函数而不是模块级单例：单例会让测试互相串味。主进程在 `index.ts` 调用一次，
 * 把实例传给索引器。
 */

const pdfProcessor: DocumentProcessor = {
  id: 'pdf-text',
  documentTypes: ['pdf'],
  extract: extractPdfText
};

const docxProcessor: DocumentProcessor = {
  id: 'docx-text',
  documentTypes: ['docx'],
  extract: extractDocxText
};

/**
 * 装配 Phase 3 的两个处理器。
 *
 * 图片**没有**处理器，这是有意的：图片里没有文本可提取，OCR 是 Phase 5 的事
 * （蓝图 §18）。不进注册表，索引器就连「要不要试试」都不会问 —— 比注册一个
 * 「永远返回 empty」的处理器诚实。
 */
export function createProcessorRegistry(): ProcessorRegistry {
  const registry = new ProcessorRegistry();
  registry.register(pdfProcessor);
  registry.register(docxProcessor);
  return registry;
}

export { extractPdfText } from './pdf-text.js';
export { extractDocxText } from './docx-text.js';
