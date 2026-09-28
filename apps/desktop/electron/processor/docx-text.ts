import type { ProcessorExtractInput, ProcessorResult } from '@nexus/core';

/**
 * DOCX 文本提取（Phase 3 / P3-10）。
 *
 * 用 `mammoth.extractRawText()`，**不是** `convertToHtml()` —— 后者是 P3-08 的 DOCX
 * Viewer 用的（它要带结构的 HTML），HTML 标签进了全文索引只会变成噪声。
 *
 * 主进程走 mammoth 的 **Node 入口**，所以传 `{ buffer }` 而不是 `{ arrayBuffer }`；
 * 传错不报错，只会得到一个「不是 ZIP」的失败。懒加载同 PDF。
 */

type MammothModule = typeof import('mammoth');

let mammothModule: Promise<MammothModule> | null = null;

function loadMammoth(): Promise<MammothModule> {
  mammothModule ??= import('mammoth').then(unwrapCommonJsDefault);
  return mammothModule;
}

/**
 * 拆掉 CJS 的 `default` 那层。mammoth 的类型声明是 `export = mammoth`，TS 的
 * `typeof import('mammoth')` 给的是**值本身**，而 Node 的动态 `import()` 把
 * `module.exports` 放在 `default` 上 —— 差一层。取 `.default`、取不到退回模块本身，
 * 原生 Node interop 与 Vite 的 SSR 变换（单测跑在这条路上）都对。不这么写症状是
 * `mammoth.extractRawText is not a function`。
 */
function unwrapCommonJsDefault<T>(module: T): T {
  const candidate = (module as unknown as { default?: unknown }).default;
  return (candidate ?? module) as T;
}

/**
 * 提取 DOCX 的文本。
 *
 * 只有空段落的 DOCX 得到 `''` 就是 `empty`，与「扫描版 PDF」同一状态、同一提示 ——
 * 用户能据以行动的信息一样（「没有可检索的文字」）。
 *
 * mammoth 的 `messages`（转换警告，绝大多数与文本无关）有意丢掉，塞进错误汇总只会让
 * 「索引有几个错误」失去意义；真要诊断时 Viewer 已经把同一批警告显示在
 * `data-docx-warnings` 上（P3-08）。
 */
export async function extractDocxText(input: ProcessorExtractInput): Promise<ProcessorResult> {
  const mammoth = await loadMammoth();

  // `Buffer.from(arrayBuffer, byteOffset, byteLength)` 是**视图**而不是拷贝 ——
  // 50MB 的 DOCX 不该为了换个类型再复制一份。
  const buffer = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);

  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();

  return text.length === 0 ? { status: 'empty', text: '' } : { status: 'extracted', text };
}
