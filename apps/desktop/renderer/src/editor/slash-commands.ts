import type { SlashCommandEntry, SlashCommandHost } from '@nexus/editor';
import { BLOCK_FORMAT_SPECS } from './block-format-specs.js';

/**
 * `/` 面板里的命令级动作。
 *
 * ## 为什么是「投影」而不是「清单」
 *
 * 面板能做的块级动作与菜单栏的「格式」菜单、命令面板**完全同一批** ——
 * 所以这里一个动作名都不写，全部从 `BLOCK_FORMAT_SPECS` 投影出来。抄一份清单的代价是
 * 加了一个块级动作之后 `/` 面板里没有它，而那不会有任何报错：面板只是「少了点什么」。
 *
 * ## `run` 先删掉用户敲的 `/查询`，再跑命令
 *
 * 不删的话 `/h1` 会留在正文里，命令把那一行变成 `# /h1`。删掉之后光标落在行首，
 * 命令看到的就是「用户在这条空行上要一个 H2」。
 *
 * 两条派发都标 `userEvent: 'format.block'`：会话的撤销栈按事务记、不做分组，标它不影响
 * 撤销步数，但**源码面**（`createSourceEditorState` 那条路带 CodeMirror 自己的 history）
 * 会因此把两步并成一个 —— 两处行为一致，撤销都是「先撤销格式、再撤销我打的查询串」。
 *
 * ## 标签是**现读**的
 *
 * `entries()` 每次调用才去取译文，而不是建 host 时取一次：面板是常驻对象，
 * 而语言可以在它活着的时候改。
 */
export function createSlashCommandHost(
  label: (key: string) => string,
  run: (id: string) => void
): SlashCommandHost {
  return {
    entries: (): SlashCommandEntry[] =>
      BLOCK_FORMAT_SPECS.map((spec) => ({
        commandId: spec.id,
        tokens: spec.tokens,
        label: label(spec.labelKey)
      })),

    run: (view, commandId, from, to) => {
      if (to > from) {
        view.dispatch({
          changes: { from, to, insert: '' },
          selection: { anchor: from },
          userEvent: 'format.block'
        });
      }
      run(commandId);
    }
  };
}
