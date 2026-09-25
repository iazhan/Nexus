import { MarkdownDocumentSession, type EditorSaveState } from '@nexus/editor';

/**
 * 工作区里打开的一份文档。
 */
export interface WorkspaceDocument {
  /**
   * 稳定标识。
   *
   * 刻意不用 filePath 当 id：未命名文档没有路径，而「另存为」会换路径 ——
   * 用路径做身份，这两件事都会让 tab 突然变成另一个 tab。
   */
  readonly id: string;
  /** 磁盘路径；null 表示尚未落盘的新文档 */
  filePath: string | null;
  /** 该文档独立的编辑会话：canonical source、selection、history 都在里面 */
  readonly session: MarkdownDocumentSession;
  saveState: EditorSaveState;
  saveError: string | null;
  readOnly: boolean;
}

export interface WorkspaceSnapshot {
  documents: readonly WorkspaceDocument[];
  activeId: string | null;
}

export interface OpenDocumentInput {
  filePath: string | null;
  content: string;
  readOnly?: boolean;
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
   * 打开一份文档并激活它。
   *
   * 路径已经在标签页里时**不新建**，直接激活既有的那个：否则同一个文件会有两份
   * 互不知情的 session，两边都能存盘，后写的静默覆盖先写的。
   */
  openDocument(input: OpenDocumentInput): WorkspaceDocument {
    if (input.filePath) {
      const existing = this.findDocumentByPath(input.filePath);
      if (existing) {
        this.activate(existing.id);
        return existing;
      }
    }

    const session = new MarkdownDocumentSession();
    session.replaceSource(input.content, { selection: { anchor: 0, head: 0 } });

    const document: WorkspaceDocument = {
      id: createDocumentId(),
      filePath: input.filePath,
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

  activate(id: string): void {
    if (this.activeId === id) return;
    if (!this.documents.some((document) => document.id === id)) return;
    this.activeId = id;
    this.emit();
  }

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

  updateActive(mutate: (document: WorkspaceDocument) => void): void {
    if (this.activeId === null) return;
    this.updateDocument(this.activeId, mutate);
  }

  setActiveFilePath(filePath: string | null): void {
    this.updateActive((document) => {
      document.filePath = filePath;
    });
  }

  setActiveReadOnly(readOnly: boolean): void {
    this.updateActive((document) => {
      document.readOnly = readOnly;
    });
  }

  setSaveState(id: string, state: EditorSaveState, error: string | null = null): void {
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
