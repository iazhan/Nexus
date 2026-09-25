/**
 * 从 Markdown 源码里提取标题，供大纲面板使用。
 *
 * ## 为什么不用 `@nexus/markdown` 的 parser
 *
 * 大纲要的是「当前编辑器里正在写的这份文本」，而 parser 是给投影用的完整 AST ——
 * 为了拿几个标题去跑一遍全量解析不划算，而且这里需要的是**源码偏移**（点击跳转用），
 * 不是节点树。
 *
 * ## 支持范围（刻意划定的）
 *
 * - ✅ ATX 标题：`#` ~ `######`
 * - ✅ 围栏代码块内的 `#` 不当标题（``` 与 ~~~，含未闭合的围栏）
 * - ✅ CRLF
 * - ❌ Setext 标题（`===` / `---` 下划线式）—— 项目文档里没用过，先不做。
 *      真需要时再补，届时得先解决「`---` 到底是 Setext 标题还是分割线」的歧义。
 */

export interface OutlineHeading {
  /** 1 ~ 6 */
  level: number;
  /** 标题文本（已去掉首尾空白与结尾的 `#`） */
  text: string;
  /** 该行在源码中的起始偏移，用于点击跳转 */
  offset: number;
}

/** 围栏起始：至少三个反引号或波浪线。 */
const FENCE_PATTERN = /^(`{3,}|~{3,})/;
/** ATX 标题：1~6 个 `#` + 空白 + 文本，结尾的 `#` 可有可无。 */
const ATX_PATTERN = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/;

export function extractOutline(source: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];

  let fenceMarker: string | null = null;
  let offset = 0;

  // 按 \n 切分，再手工去掉行尾的 \r —— 否则 CRLF 文档的标题文本会带一个不可见字符
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();

    const fence = FENCE_PATTERN.exec(trimmed);
    if (fence) {
      const marker = fence[1]![0]!;
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        // 只有同种字符的围栏才能闭合（``` 不会被 ~~~ 关掉）
        fenceMarker = null;
      }
      offset += rawLine.length + 1;
      continue;
    }

    // 围栏内的内容一律不解析 —— 代码块里的 `# 注释` 不是标题
    if (fenceMarker === null) {
      const heading = ATX_PATTERN.exec(trimmed);
      if (heading) {
        const text = heading[2]!.trim();
        if (text.length > 0) {
          headings.push({ level: heading[1]!.length, text, offset });
        }
      }
    }

    offset += rawLine.length + 1;
  }

  return headings;
}
