import { MarkdownDocumentSession, type EditorSaveState } from '@nexus/editor';
import {
  documentTypeForPath,
  isMarkdownPath,
  type ViewerDocumentType
} from '@nexus/core';

/**
 * 一份打开的文档走哪条渲染路径。
 *
 * 只有两种，因为 Phase 3 的文档只有两种**行为契约**：
 * - `editor`  —— 可编辑 Markdown。canonical source 就是它自己，有 session。
 * - `viewer`  —— 严格只读的附件（pdf / docx / 图片）。没有 source/投影二分，
 *   也没有 session —— 给它建一个 MarkdownDocumentSession 只会造出「能改、
 *   但改完没地方去」的假象（验收第 3 条要求原文件 mtime 与哈希不变）。
 *
 * 之所以把「用哪个渲染器」放在**文档自己身上**而不是 App 里另存一份
 * `viewerDocument` 状态：那份状态与文档集合是两份事实源，多标签页下必然漂移
 * （症状是「标签页高亮的是 A、渲染的是 B」）。§7 第 8 条要求 P3-05 先把
 * 「文档上下文」抽成独立层，这一层就是它。
 */
export type DocumentKind = 'editor' | 'viewer';

/** 两类文档共有的部分：身份、路径、以及状态栏/标签页要读的那几个字段。 */
interface WorkspaceDocumentBase {
  /**
   * 稳定标识。
   *
   * 刻意不用 filePath 当 id：未命名文档没有路径，而「另存为」会换路径 ——
   * 用路径做身份，这两件事都会让 tab 突然变成另一个 tab。
   */
  readonly id: string;
  /** 磁盘路径；null 表示尚未落盘的新文档（只可能是 editor） */
  filePath: string | null;
  /**
   * 保存态。
   *
   * 附件恒为 `'readonly'` —— 状态栏与标签页都按它渲染，于是「附件是只读的」
   * 在 UI 上不需要第二条判据（`SAVE_STATE_KEY['readonly']` = 只读）。
   */
  saveState: EditorSaveState;
  saveError: string | null;
  readOnly: boolean;
}

/** 可编辑 Markdown。canonical source 就是它自己。 */
export interface EditorDocument extends WorkspaceDocumentBase {
  readonly kind: 'editor';
  readonly type: 'markdown';
  /** 该文档独立的编辑会话：canonical source、selection、history 都在里面 */
  readonly session: MarkdownDocumentSession;
}

/** 严格只读的附件（pdf / docx / 图片）。没有 source/投影二分，也没有 session。 */
export interface ViewerDocument extends WorkspaceDocumentBase {
  readonly kind: 'viewer';
  readonly type: ViewerDocumentType;
  /**
   * 附件**必定**有磁盘路径。
   *
   * 收窄基类那个 `string | null`：未落盘的「未命名文档」只可能是可编辑的 Markdown，
   * 而附件没有路径就无从加载 —— 于是渲染器拿到的描述对象里 `path` 不必再兜底。
   */
  filePath: string;
  /**
   * 恒为 null。
   *
   * 给附件造一个 `MarkdownDocumentSession` 只会造出「能改、但改完没地方去」
   * 的假象（验收第 3 条要求原文件 mtime 与哈希不变），所以这一层直接不给。
   */
  readonly session: null;
}

/**
 * 工作区里打开的一份文档。
 *
 * 用**判别联合**而不是「一个带可选字段的宽接口」：`kind` 一旦收窄，
 * `session` 与 `type` 就跟着收窄 —— 「附件没有 session」「附件不是 Markdown」
 * 于是成了类型系统保证的事实，而不是一条要靠人记住、靠代码评审守住的约定。
 * 宽接口下 `activeDocument.session` 处处要写 `?? 兜底`，而那个兜底恰好会
 * 把「往只读文档里写」变成一个不报错的静默行为。
 */
export type WorkspaceDocument = EditorDocument | ViewerDocument;

export interface WorkspaceSnapshot {
  documents: readonly WorkspaceDocument[];
  activeId: string | null;
}

export interface OpenDocumentInput {
  filePath: string | null;
  content: string;
  readOnly?: boolean;
}

export interface OpenViewerDocumentInput {
  /** 只读文档必须有磁盘路径 —— 没有路径的附件无从加载。 */
  filePath: string;
  /**
   * 由调用方按路径判定后传入，且**必须**是非 Markdown 类型。
   *
   * 用 `ViewerDocumentType` 而不是 `DocumentType`：把「Markdown 不许开成
   * viewer」变成类型错误，而不是一条要靠人记住的约定。
   */
  type: ViewerDocumentType;
}

let documentCounter = 0;

function createDocumentId(): string {
  documentCounter += 1;
  return `doc_${documentCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 工作区状态：打开了哪些文档、哪一个是活动的。
 *
 * 这是**单一事实源**。App 从它派生 `filePath` / `session` / `saveState`，
 * 而不是各自再持一份 `useState` —— 两份状态迟早会漂移，而且漂移时
 * 症状是「界面显示 A 的路径、保存写的是 B 的内容」这种最难查的一类。
 *
 * 打开的东西**不都是可编辑文档**：`kind` 区分 editor 与 viewer，两类共用
 * 同一份文档集合与同一套标签页。此前 viewer 是 App 里另立的
 * `viewerDocument` useState（且刻意不进标签页），P3-05 把它并了进来 ——
 * 否则「现在看的是哪个文档」有两个答案，而标签栏只认识其中一个。
 *
 * 不依赖 React：纯类 + 订阅，可以直接单测。React 侧用 useSyncExternalStore 订阅。
 */
export class WorkspaceStore {
  private documents: WorkspaceDocument[] = [];
  private activeId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot = { documents: [], activeId: null };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 供 useSyncExternalStore 使用：引用必须稳定，只在真正变更时重建。 */
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = { documents: [...this.documents], activeId: this.activeId };
    for (const listener of this.listeners) {
      listener();
    }
  }

  getDocuments(): readonly WorkspaceDocument[] {
    return this.snapshot.documents;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getActive(): WorkspaceDocument | null {
    if (this.activeId === null) return null;
    return this.documents.find((document) => document.id === this.activeId) ?? null;
  }

  findDocumentByPath(filePath: string): WorkspaceDocument | null {
    return this.documents.find((document) => document.filePath === filePath) ?? null;
  }

  /**
   * 打开一份可编辑的 Markdown 文档并激活它。
   *
   * 路径已经在标签页里时**不新建**，直接激活既有的那个：否则同一个文件会有两份
   * 互不知情的 session，两边都能存盘，后写的静默覆盖先写的。
   */
  openDocument(input: OpenDocumentInput): EditorDocument {
    // 路径必须是 Markdown 或空（未命名）。放一份 PDF 进来只会在 `type` 上
    // 写下一个与 `kind: 'editor'` 矛盾的谎 —— 而下游（状态栏、TabBar、
    // 渲染分支）全都信 `type`。判定错了就在最早处炸掉。
    if (input.filePath !== null && !isMarkdownPath(input.filePath)) {
      throw new Error(
        `openDocument(): "${input.filePath}" is not a Markdown document — ` +
          'use openViewerDocument() for attachments'
      );
    }

    const existing = input.filePath ? this.findDocumentByPath(input.filePath) : null;
    if (existing) {
      this.activate(existing.id);
      return this.expectEditor(existing, 'openDocument');
    }

    const session = new MarkdownDocumentSession();
    session.replaceSource(input.content, { selection: { anchor: 0, head: 0 } });

    const document: EditorDocument = {
      id: createDocumentId(),
      filePath: input.filePath,
      kind: 'editor',
      type: 'markdown',
      session,
      saveState: input.readOnly ? 'readonly' : 'clean',
      saveError: null,
      readOnly: input.readOnly ?? false
    };

    this.documents = [...this.documents, document];
    this.activeId = document.id;
    this.emit();
    return document;
  }

  /**
   * 打开一份只读文档（pdf / docx / 图片）并激活它。
   *
   * 与 `openDocument` 分成两个方法而不是加一个判别字段：editor 要 `content`、
   * viewer 不能有 `content`（给了也只能丢），把这条差异放进类型里比放进注释里可靠。
   */
  openViewerDocument(input: OpenViewerDocumentInput): ViewerDocument {
    // 类型必须与路径一致。
    //
    // 渲染器是**照 `type` 选的**，所以一个错配的 type 会把 PNG 交给 PDF 渲染器 ——
    // 表现是「打开图片报 PDF 解析失败」，而排查方向会完全跑偏。判据就在手边，
    // 没有理由让它变成一个运行期才发现的问题。
    const actualType = documentTypeForPath(input.filePath);
    if (actualType !== input.type) {
      throw new Error(
        `openViewerDocument(): type "${input.type}" does not match "${input.filePath}" ` +
          `(detected ${actualType ?? 'unsupported'})`
      );
    }

    const existing = this.findDocumentByPath(input.filePath);
    if (existing) {
      this.activate(existing.id);
      return this.expectViewer(existing, 'openViewerDocument');
    }

    const document: ViewerDocument = {
      id: createDocumentId(),
      filePath: input.filePath,
      kind: 'viewer',
      type: input.type,
      session: null,
      saveState: 'readonly',
      saveError: null,
      readOnly: true
    };

    this.documents = [...this.documents, document];
    this.activeId = document.id;
    this.emit();
    return document;
  }

  /**
   * 收窄 + 断言。
   *
   * 按上面两条路径守卫，这两个分支**在构造上不可达**：`openDocument` 只接受
   * Markdown 路径，而 Markdown 路径不可能被 `openViewerDocument` 接受
   * （它要求 type 与路径一致），反之亦然 —— 所以「同一路径已按另一种类型打开」
   * 推不出来。它们存在的作用是把这个推理**钉在代码里**：哪天白名单或守卫改了，
   * 症状会是一句明确的抛错，而不是「同一路径静默开出两份、两边各自渲染」。
   *
   * 不用「找不到就新建」来兜住它：那正是本仓库反复吃亏的静默兼容。
   */
  private expectEditor(document: WorkspaceDocument, method: string): EditorDocument {
    if (document.kind !== 'editor') {
      throw new Error(
        `${method}(): "${document.filePath}" is already open as a viewer document`
      );
    }
    return document;
  }

  private expectViewer(document: WorkspaceDocument, method: string): ViewerDocument {
    if (document.kind !== 'viewer') {
      throw new Error(
        `${method}(): "${document.filePath}" is already open as an editor document`
      );
    }
    return document;
  }

  /**
   * 当前活动的**可编辑**文档；活动的是附件时返回 null。
   *
   * App 里几十处 `session.xxx` 依赖它 —— 抽成方法而不是让调用点各自判 kind，
   * 是为了让「活动文档不是 editor」这件事只有一个判断点。
   */
  getActiveEditor(): EditorDocument | null {
    const active = this.getActive();
    return active?.kind === 'editor' ? active : null;
  }

  /**
   * 切换活动文档。
   *
   * 写成箭头函数属性是**必须的**：它会作为 `onActivate={store.activate}` 直接传给
   * React 组件，普通方法在那一刻就丢了 `this`，调用时抛 `Cannot read properties of
   * undefined`，而异常发生在事件处理里 —— 表现是「点了没反应」，不报错、不留痕。
   * 同一个类里 `subscribe` / `getSnapshot` 也是出于同样的理由写成箭头函数的。
   */
  activate = (id: string): void => {
    if (this.activeId === id) return;
    if (!this.documents.some((document) => document.id === id)) return;
    this.activeId = id;
    this.emit();
  };

  /**
   * 关闭一个标签页，返回关闭后活动的文档 id。
   *
   * 激活规则：优先右边那个，没有就取左边 —— 与浏览器和主流编辑器一致，
   * 关闭后视口不会跳到文档列表的另一端。
   */
  closeDocument(id: string): string | null {
    const index = this.documents.findIndex((document) => document.id === id);
    if (index === -1) return this.activeId;

    const wasActive = this.activeId === id;
    this.documents = this.documents.filter((document) => document.id !== id);

    if (wasActive) {
      const next = this.documents[index] ?? this.documents[index - 1] ?? null;
      this.activeId = next?.id ?? null;
    }

    this.emit();
    return this.activeId;
  }

  get isEmpty(): boolean {
    return this.documents.length === 0;
  }

  /** 就地修改一个文档并通知订阅者。 */
  updateDocument(id: string, mutate: (document: WorkspaceDocument) => void): void {
    const document = this.documents.find((candidate) => candidate.id === id);
    if (!document) return;
    mutate(document);
    this.emit();
  }

  /**
   * 就地修改活动的**可编辑**文档；活动的是附件时什么也不做。
   *
   * 刻意**不提供**一个「改活动的任意文档」的版本：附件的保存态 / 路径 / 可写性
   * 都不该被改，而一个一视同仁的 `updateActive` 会让每个调用点各自去判 kind ——
   * 漏掉一处就是「往只读文档里写」，且不报错。收窄到 editor，这类 bug 就没了入口。
   */
  updateActiveEditor(mutate: (document: EditorDocument) => void): void {
    const active = this.getActiveEditor();
    if (!active) return;
    // 交给 `updateDocument` 落库与通知：这里只多一道收窄。
    // 不把 `mutate` 直接传进去是因为函数参数是逆变的 —— 收窄后的签名
    // 反而不能用在接受 `WorkspaceDocument` 的地方。
    this.updateDocument(active.id, (document) => {
      if (document.kind === 'editor') mutate(document);
    });
  }

  /**
   * 下面三个「活动文档」的写入口都**只作用于 editor**。
   *
   * 它们的语义全是「可写文档的元数据」：路径、可写性、保存态。活动的是附件时
   * 这些写操作没有任何正当含义，而放过去会造成具体损坏 —— 附件标签页上按 Ctrl+S
   * 会走 `performSaveAs`，把**附件的路径改成用户另存的新路径**，状态栏还会显示
   * 「已修改」。与其在每个调用点判一次，不如让这一层直接拒绝。
   */
  setActiveFilePath(filePath: string | null): void {
    this.updateActiveEditor((document) => {
      document.filePath = filePath;
    });
  }

  setActiveReadOnly(readOnly: boolean): void {
    this.updateActiveEditor((document) => {
      document.readOnly = readOnly;
    });
  }

  setSaveState(id: string, state: EditorSaveState, error: string | null = null): void {
    const target = this.documents.find((candidate) => candidate.id === id);
    if (!target || target.kind !== 'editor') return;
    this.updateDocument(id, (document) => {
      document.saveState = state;
      document.saveError = error;
    });
  }

  setActiveSaveState(state: EditorSaveState, error: string | null = null): void {
    if (this.activeId === null) return;
    this.setSaveState(this.activeId, state, error);
  }
}
