import { Compartment, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Vim 键位：把 `@replit/codemirror-vim` 挂进编辑器，并**只在用户真的打开它时才加载**。
 *
 * ## 为什么要懒加载
 *
 * 这个包是 CodeMirror 5 键位表加一层 CM6 适配，压完仍有几百 KB —— 而绝大多数人不会开它。
 * 静态 import 会让每个用户都为它付启动成本。所以这里只导出「加载」与「装上」两件事，
 * 由调用方在设置打开时调用 `loadVimExtension()`，拿到扩展再 `applyEditorVim()`。
 *
 * **动态 import 的边界就落在这个文件里**：调用方拿到的只是一个不透明的 `Extension`，
 * 不认识这个包，也就不可能不小心把它变成静态依赖。
 *
 * ## 它只吃掉自己绑定的键
 *
 * 这是能否与本应用共存的关键，也是动手前必须确认的一条：`@replit/codemirror-vim` 走的是
 * DOM `keydown` 处理器 + `EditorView.inputHandler`，**只有真正匹配到 vim 绑定**（`handleKey`
 * 返回真）时才 `preventDefault()` + `stopPropagation()`；没匹配上的键原样落回 CodeMirror 的
 * keymap —— 也就是本应用的 `editorKeybindings`（保存、加粗、命令面板……）照常工作。
 *
 * 反过来说：**它不提供 keymap，所以不需要 `Prec.high`**。以为「vim 要压过应用键位」而套一层
 * 高优先级，改的是不存在的东西。
 *
 * ## 刻意不缓存失败的 Promise
 *
 * 加载失败（磁盘上少了 chunk、CSP 挡住）时把 rejected promise 留在缓存里，会让用户**修好之后
 * 也永远打不开**。所以失败即清空，下一次开关重新试。
 */

/**
 * 装 vim 的那个槽位。与 `source-editor.ts` 里另外几个 compartment 分开声明，是因为它由
 * **异步**加载决定什么时候有内容 —— 放一起会让人以为它和 `lineNumbers` 一样在构造时就能定。
 */
export const vimCompartment = new Compartment();

let loaded: Extension | null = null;
let pending: Promise<Extension> | null = null;

/** 加载并缓存 vim 扩展。同一份扩展重复装到多个视图上是安全的（它是无状态的配置集合）。 */
export function loadVimExtension(): Promise<Extension> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= import('@replit/codemirror-vim').then(
    (module) => {
      loaded = module.vim();
      pending = null;
      return loaded;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    }
  );
  return pending;
}

/**
 * 把 vim 装上或卸下。传 `null` 表示关掉。
 *
 * 开关走 compartment 重配置而不是重建视图：重建会丢掉撤销历史与滚动位置，而用户只是想换个
 * 打字方式。
 */
export function applyEditorVim(view: EditorView, extension: Extension | null): void {
  view.dispatch({ effects: [vimCompartment.reconfigure(extension ?? [])] });
}
