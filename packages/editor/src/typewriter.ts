import { type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * 打字机模式：光标所在行尽量停在视口**垂直中央**，视线不必在屏幕上下追着跑。
 *
 * ## 为什么不能直接在 update 里 dispatch
 *
 * `EditorView.update` 期间 `updateState` 是 `Updating`，此时再 dispatch 会抛
 * `Calls to EditorView.update are not allowed while an update is in progress`。
 * 而「光标动了就滚」这件事天然发生在 update 里。两条出路：① `requestMeasure` 的 write
 * 阶段（rAF，慢一帧）；② 微任务。这里选②——它紧跟本次更新之后、**绘制之前**执行，
 * 用户看不到延迟，而①要多等一帧才有反馈，快速连打时能看出滚动在追。
 *
 * 微任务里 dispatch 会再引发一次 update，但那次没有 `userEvent` 标注，谓词不成立，不会成环。
 *
 * ## 只在**用户**引起的选区变化上跟
 *
 * 同一个文档可能同时开在多个 surface 上（源码 / 视觉 / 分屏），session 会把一处的光标
 * 同步给另一处 —— 那些事务是程序发出的。不加这道判据，在视觉面点一下光标，源码面会跟着
 * 滚一次，而用户根本没在那儿打字。
 *
 * 判据用 `Transaction.userEvent` 标注而不是「docChanged 或 selectionSet」：后者会把
 * 标签页切换时的滚动恢复、标题锚点跳转、行号开关的重配置全都算进来。
 *
 * ## 一个已知的边界
 *
 * 文档**首尾**那几行滚不到正中：视口最多只能滚到 `scrollHeight - clientHeight`，第一行
 * 想居中需要上方有半屏空白，而那是靠给内容加 padding 造出来的。这里**刻意不加** ——
 * padding 会改变 `.cm-content` 的盒模型，而块级 widget 的高度、`blockGapField` 的段间距
 * 都按现有盒模型算，为一个 P2 开关去动它们是赔本买卖。长文档才是这个功能真正有用的地方，
 * 那里滚得动。
 */
export function createTypewriterExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      /** 一次更新只排一次滚动：连打时每帧最多滚一次。 */
      private pending = false;
      private alive = true;

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!this.shouldFollow(update)) return;
        if (this.pending) return;
        this.pending = true;

        queueMicrotask(() => {
          this.pending = false;
          // 视图可能在微任务排队期间被销毁（切 surface、关标签页）。
          // 对已销毁的视图 dispatch 会抛，所以这一句是必需的而不是保险。
          if (!this.alive) return;
          // 光标位置**在这里现读**，不在排队时快照：同一个同步块里发生两次光标移动时
          // （测试里连发两次事务就是这样），快照会让视口停在第一处。
          this.view.dispatch({
            effects: EditorView.scrollIntoView(this.view.state.selection.main.head, {
              y: 'center'
            })
          });
        });
      }

      destroy(): void {
        this.alive = false;
      }

      private shouldFollow(update: ViewUpdate): boolean {
        if (!update.selectionSet && !update.docChanged) return false;
        // 输入法组合期间不要动视口：候选框的位置跟着滚动跑，会把正在选字的用户晃掉。
        if (update.view.composing) return false;
        return update.transactions.some((transaction) => transaction.isUserEvent('select'))
          || update.transactions.some((transaction) => transaction.isUserEvent('input'))
          || update.transactions.some((transaction) => transaction.isUserEvent('delete'));
      }
    }
  );
}
