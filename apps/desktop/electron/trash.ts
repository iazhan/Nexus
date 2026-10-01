import { shell } from 'electron';
import type { TrashAdapter } from './file-service.js';

/**
 * 用 Electron 的 `shell.trashItem` 实现「移到回收站」。
 *
 * 为什么不干脆一律 `fs.unlink` 再在文案里说「已删除」：`unlink` 是**不可逆**的，
 * 而用户选「移到回收站」时买的正是**可逆**这一半。Electron 只提供这一个入口
 * （`FileSystemAdapter` 描述的是 `fs` 能做的事，里面没有回收站），所以它必须单独存在。
 *
 * 失败**不吞**：`trashItem` 在目标不可回收时（网络盘、权限不足、文件已被移走）会 reject。
 * 那时必须让调用方知道「删除没有发生」—— 静默当成成功的话，用户会以为文件在回收站里，
 * 而它其实还在原地。
 */
export function createElectronTrash(): TrashAdapter {
  return {
    trashItem: (filePath: string) => shell.trashItem(filePath)
  };
}
