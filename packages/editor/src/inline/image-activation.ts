import type { EditorView } from '@codemirror/view';

/**
 * 激活图片时把光标落在哪个偏移。
 *
 * 优先落进 `](…)` 里的**地址段** —— 那是用户真正要改的东西，落进去就能直接重打路径。
 * 嵌入 `![[x.png]]` 没有 `](`，退回目标名内部。
 *
 * 判据是「严格落在 range 内部」（见投影层的 `isNodeRevealed`）：整节点替换的 widget 会把
 * 点击吞掉，CodeMirror 只能把光标贴到 range 的**边界**，贴边界永远揭示不了 ——
 * 图片会永远停在渲染态，一点就回到图片。这与行内公式是同一条约束。
 */
export function imageActivationAnchor(from: number, to: number, raw: string): number {
  const open = raw.indexOf('](');
  if (open !== -1) {
    const anchor = from + open + 2;
    if (anchor > from && anchor < to) return anchor;
  }
  return Math.max(from, Math.min(to - 1, from + 1));
}

/**
 * 把光标送进「被整体替换」的图片范围内部：下一帧装饰重建时替换消失，
 * `![](…)` / `![[…]]` 变回真实文档文本，就地可改 —— 不弹浮层。
 *
 * 与 `activateMathSource` 同构。两者的区别只在锚点算法：公式要跳过 `$` 定界符，
 * 图片要跳过 `![alt](`。
 */
export function activateImageSource(
  view: EditorView,
  from: number,
  to: number,
  raw: string
): void {
  view.focus();
  view.dispatch({
    selection: { anchor: imageActivationAnchor(from, to, raw) }
  });
}
