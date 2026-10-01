/**
 * 文档内锚点（`#slug`）解析与跳转。
 *
 * 锚点是纯文档操作：Markdown source 是唯一事实源，所以索引每次从 source 现算，
 * 不缓存、不挂视图状态——文档一改，索引立即一致，不存在失效窗口。
 */
import { parseMarkdown } from '@nexus/markdown';
import { EditorView } from '@codemirror/view';
import { walkBlockNodes } from './ast-walker.js';
import { getInlineNodePlainText } from './inline-edit.js';

export interface HeadingAnchorEntry {
  slug: string;
  text: string;
  depth: number;
  /** 标题行起始偏移，可直接作为选区落点。 */
  from: number;
}

/**
 * GitHub 风格 slug：小写 → 去掉标点（保留 Unicode 字母/组合符号/数字/空白/`-`/`_`）
 * → 空白折叠成单个连字符。
 *
 * 例：`## 13. 转义与常见陷阱` → `13-转义与常见陷阱`，
 * 与文档里手写的 `#13-转义与常见陷阱` 一致。中英文混排与 CJK 都不做转写。
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s\-_]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * 按文档顺序扫描所有标题，生成锚点索引。
 *
 * 递归进 blockquote / list-item，因为标题可能嵌在引用块或列表里；
 * 纯文本取自 AST 的 inline children（而不是 raw），这样标题里的行内代码、
 * 强调、公式不会把标记符号带进 slug。
 *
 * 重复标题与 GitHub 一致地追加 `-1`、`-2`…… 保证每个锚点唯一。
 */
export function buildHeadingIndex(source: string): HeadingAnchorEntry[] {
  const { root } = parseMarkdown(source);
  const entries: HeadingAnchorEntry[] = [];
  const occurrences = new Map<string, number>();

  walkBlockNodes(root.children, (block) => {
    if (block.type !== 'heading') return;

    const text = block.children.map(getInlineNodePlainText).join('').trim();
    const base = slugifyHeading(text);
    if (!base) return;

    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);

    entries.push({
      slug: occurrence === 0 ? base : `${base}-${occurrence}`,
      text,
      depth: block.depth,
      from: block.range.from
    });
  });

  return entries;
}

/**
 * 解析 `#anchor` 得到标题起始偏移；未命中返回 `null`。
 *
 * 先 `decodeURIComponent`：锚点在 Markdown 里常被百分号转义（中文标题尤其常见）。
 * 非法转义序列按原样比对，好过直接判定失败。
 */
export function resolveHeadingAnchor(source: string, anchor: string): number | null {
  const raw = anchor.startsWith('#') ? anchor.slice(1) : anchor;
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 非法百分号转义：按原样比对
  }

  const target = slugifyHeading(decoded);
  if (!target) return null;

  const entry = buildHeadingIndex(source).find((item) => item.slug === target);
  return entry ? entry.from : null;
}

/**
 * 把光标落到目标偏移上，并让该行成为**视口第一行**——行号也完整可见。
 *
 * **凡是「跳到某一行」都要走这里**，包括文档内锚点（`revealHeadingAnchor`）和
 * 大纲面板。原因全在下面那两处：`y: 'start'` 与 `alignLineBoxToTop`。
 */
export function revealHeadingAt(view: EditorView, from: number): void {
  // 先聚焦再滚动：聚焦会让投影展开目标行的标记（行高可能微调），
  // 滚动必须发生在那之后，落点才准。
  view.focus();

  view.dispatch({
    selection: { anchor: from },
    // 必须显式给 `y: 'start'`。CM 默认策略是 `'nearest'`，只做**最小滚动**：
    // 目标在视口下方时它只会滚到"刚好可见"，也就是贴在视口**底边**——
    // 用户看到的正是"跳过去的行跑到页面最后一行"。
    //
    // 也别图省事写成 `scrollIntoView: true`：那是 `{ y: 'nearest' }` 的简写，
    // 同一个坑换一身衣服。
    effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 0 })
  });

  alignLineBoxToTop(view, from);
}

/**
 * 解析 `#anchor` 并跳转；返回 `false` 表示锚点未命中，调用方应自行决定降级行为。
 */
export function revealHeadingAnchor(view: EditorView, anchor: string): boolean {
  const from = resolveHeadingAnchor(view.state.doc.toString(), anchor);
  if (from === null) return false;

  revealHeadingAt(view, from);
  return true;
}

/**
 * 补正落点：让目标行的**行盒顶边**（而不是行内文本顶边）贴住视口顶边。
 *
 * 为什么要补：`y: 'start'` 对齐的是行内**文本**顶边，而 gutter 里的行号画在行盒顶部，
 * 行盒比文本盒高出的那截正好把行号顶出视口（实测 h2 被裁 5.7px，近三分之一字高）。
 * 差值随标题层级变（h1 = 8px、h2 = 6px），所以不能用常量，必须按目标行现量。
 *
 * 为什么不能滚动前量：目标行通常不在 DOM 里（视口虚拟化），`coordsAtPos` 直接返回 `null`。
 * 也正因如此，补正只能放在滚动渲染**之后**。下一帧的 measure 读/写阶段完成补正，
 * 与 CM 自己的布局同批，不额外触发布局抖动。
 *
 * 为什么量目标行自己的行盒、而不是"上一行的底边"：两者几何上等价（行盒是连续的），
 * 但目标行**一定**已渲染（它就在视口里），上一行在滚动落定前正好整个在视口上方，
 * 是否被渲染取决于虚拟化的余量。而且块级 widget（代码块 / 表格 / mermaid 岛屿）会作为
 * 兄弟节点插在行与行之间，那时上一个 `.cm-line` 与目标行并不相邻，它的底边根本不是目标行的顶边。
 * 另外 CM 的对齐基准是 `coordsAtPos(head).top`（行内**文本**矩形），补正只能相对它表达，
 * 换成底边也得绕回同一个数。
 */
function alignLineBoxToTop(view: EditorView, pos: number): void {
  const win = view.dom.ownerDocument.defaultView;
  if (!win) return;

  win.requestAnimationFrame(() => {
    if (isDestroyed(view)) return;
    view.requestMeasure({
      read: (measured) => {
        const textRect = measured.coordsAtPos(pos);
        const lineElement = findLineElement(measured, pos);
        if (!textRect || !lineElement) return 0;

        const lineTop = lineElement.getBoundingClientRect().top;
        // 只在行盒**确实被顶出视口**时补正。目标离文末不足一屏时滚动会被钳制在最大值，
        // 此时行盒落在视口**下方**（lineTop > 0），再减就是往回退——会把最后一行切掉。
        if (lineTop >= measured.scrollDOM.getBoundingClientRect().top) return 0;

        return textRect.top - lineTop;
      },
      write: (overhang) => {
        // 向上取整：宁可让上一行露出不到 1px 的下缘，也不能让第一行的行号被裁。
        if (overhang <= 0 || isDestroyed(view)) return;
        view.scrollDOM.scrollTop -= Math.ceil(overhang);
      }
    });
  });
}

/** `EditorView.destroyed` 在 d.ts 里是 private，跳转可能跨越一次卸载，这里显式读一次。 */
function isDestroyed(view: EditorView): boolean {
  return (view as unknown as { destroyed?: boolean }).destroyed === true;
}

/**
 * 找到包含 `pos` 的那一行 DOM。
 *
 * `pos` 落在被替换区间（标题的 `#` 被 widget 顶掉）里时 `domAtPos` 可能给出
 * widget 节点或抛错，所以沿父链上溯找 `.cm-line`，再退回扫描已渲染的行。
 */
function findLineElement(view: EditorView, pos: number): HTMLElement | null {
  try {
    let node: Node | null = view.domAtPos(pos).node;
    while (node && node !== view.contentDOM) {
      const element = node as HTMLElement;
      if (typeof element.classList?.contains === 'function' && element.classList.contains('cm-line')) {
        return element;
      }
      node = node.parentNode;
    }
  } catch {
    // 落到未渲染或被替换的位置：退回扫描
  }

  const lines = view.contentDOM.querySelectorAll<HTMLElement>('.cm-line');
  for (const element of Array.from(lines)) {
    try {
      if (pos >= view.posAtDOM(element, 0) && pos <= view.posAtDOM(element, element.childNodes.length)) {
        return element;
      }
    } catch {
      // 该行已失效，跳过
    }
  }
  return null;
}
