import type { EditorView } from '@codemirror/view';

/**
 * 激活公式时应该把光标落在哪个偏移：紧跟在起始定界符之后，并夹在 `to - 1` 之内
 * （空公式 `$$` 时 `from + 2` 会越界）。
 */
export function mathActivationAnchor(from: number, to: number, raw: string): number {
  const delimiterLength = raw.match(/^\$+/)?.[0].length ?? 1;
  return Math.max(from, Math.min(to - 1, from + delimiterLength));
}

/**
 * 把光标送进「被整体替换」的公式范围内部。
 *
 * 为什么需要它：整节点替换的 widget 会把点击吞掉，CodeMirror 只能把光标贴到 range
 * 的**边界**，而揭示判据（`isNodeRevealed()` / markra 的 `selectionRevealsRange`）要求
 * 光标**严格落在范围内部**——于是永远揭示不了，公式永远停在渲染态。
 * 这里显式 dispatch 一个内部位置，下一帧装饰重建时替换消失、源码变回真实文本。
 */
export function activateMathSource(
  view: EditorView,
  from: number,
  to: number,
  raw: string
): void {
  view.focus();
  view.dispatch({
    selection: { anchor: mathActivationAnchor(from, to, raw) }
  });
}

