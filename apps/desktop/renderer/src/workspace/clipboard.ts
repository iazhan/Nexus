import { useSyncExternalStore } from 'react';

/**
 * 文件剪贴板 —— 「剪切了、等着粘贴」这个状态。
 *
 * ## 为什么不用系统剪贴板
 *
 * OS 剪贴板只有「一段数据」，没有**待执行**这个状态 —— 而「剪切」的全部内容就是它。
 * 而且我们剪的是**工作区内的路径引用**，不是文件内容：写进系统剪贴板只会让用户
 * 粘到别处时得到一串裸路径。
 *
 * 代价说清楚：跨窗口 / 跨应用粘贴不支持；关掉窗口就没了（不做持久化）。
 * **换工作区就失效** —— 存的是绝对路径，换根之后它指向的东西已经不在这棵树里了。
 * 那条失效不是靠 effect 去「清空」，而是 `useClipboard()` 按根过滤（见下）：
 * 一次清空要挂在「工作区变了」这个时刻上，而那个时刻有好几个来源（打开、切换、恢复），
 * 漏掉任何一个的表现都是「粘出来一个别处的文件」。
 *
 * ## 为什么是模块级的
 *
 * 剪贴板要跨组件（树行的灰化在侧栏、菜单项在 `App`），而它不属于任何一棵子树。
 * 用 `useSyncExternalStore` 包一层是为了让订阅者跟着重渲染 —— 换个 `useState` 放在
 * `App` 里再往下传三层，等于把「谁都能读」这件事变成「谁都得接一根线」。
 */

export interface ClipboardEntry {
  /** 绝对路径。 */
  path: string;
  /** 工作区相对路径。剪贴板只在同一个工作区里有效，存下来省一次换算。 */
  relativePath: string;
  name: string;
  type: 'file' | 'directory';
  /** `cut` 的源行在树上**变灰** —— 这是剪切唯一的可见反馈。 */
  mode: 'copy' | 'cut';
  /** 它属于哪个工作区根。换工作区之后这份剪贴板不再被任何人看见。 */
  rootPath: string;
}

let current: ClipboardEntry | null = null;
const listeners = new Set<() => void>();

/** 读当前剪贴板。**不过滤工作区** —— 过滤在 `useClipboard()` 里，理由见它的说明。 */
export function readClipboard(): ClipboardEntry | null {
  return current;
}

export function writeClipboard(entry: ClipboardEntry | null): void {
  current = entry;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 当前工作区里的剪贴板内容。别的根上剪的不算 —— 那是「换工作区之后它就不该还能粘」。
 *
 * 三个参数都进 `useSyncExternalStore`：`getSnapshot` 必须返回**引用稳定**的东西，
 * 而这里返回的是模块里那个对象本身（每次写入整体替换），所以同一份内容两次读到的
 * 是同一个引用，不会把 React 拖进无限重渲染。
 */
export function useClipboard(rootPath: string | null): ClipboardEntry | null {
  const entry = useSyncExternalStore(subscribe, readClipboard, readClipboard);
  if (entry === null || rootPath === null) return null;
  return entry.rootPath === rootPath ? entry : null;
}
