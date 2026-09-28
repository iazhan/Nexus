import {
  isViewerDocumentType,
  VIEWER_DOCUMENT_TYPES,
  type IndexedDocument,
  type ViewerDocumentType
} from '@nexus/core';

/**
 * 附件区里的一行。包一层是为了带上「同名消歧」这个**由分组算出来的**信息 ——
 * 它是分组逻辑的产物，不该塞进索引文档（那是派生数据）。
 */
export interface AttachmentEntry {
  readonly document: IndexedDocument;
  /**
   * 同组内出现同名文件时给出它所在的相对目录；**无同名时为 `null`**。
   * 空串表示「文件就在工作区根目录」，与 `null` 是两件事。
   *
   * 只在同名时给：侧栏本来就窄，每行都挂目录前缀会把文件名挤掉，而绝大多数附件不重名。
   */
  readonly directoryHint: string | null;
}

/** 附件区里的一个分组。 */
export interface AttachmentGroup {
  readonly type: ViewerDocumentType;
  readonly entries: readonly AttachmentEntry[];
}

/** 侧栏需要的两类文档。 */
export interface SidebarDocuments {
  /** 进笔记树（目录结构）的文档 */
  readonly notes: readonly IndexedDocument[];
  /** 进附件区（按类型分组）的文档 */
  readonly attachments: readonly IndexedDocument[];
}

/**
 * 按「进笔记树还是进附件区」把索引文档分成两类。
 *
 * **附件用 `isViewerDocumentType()` 正向判定**，其余归笔记树。方向是刻意的：反过来会让
 * 将来新增的、既不是 Markdown 也不在 viewer 清单里的类型掉进附件区，而
 * `buildAttachmentGroups()` 是按 `VIEWER_DOCUMENT_TYPES` 建组的，那个类型会被**静默
 * 丢掉** —— 两边都不出现，界面上凭空消失。归笔记树至少是**看得见**的错。
 */
export function splitIndexedDocuments(
  documents: readonly IndexedDocument[]
): SidebarDocuments {
  const notes: IndexedDocument[] = [];
  const attachments: IndexedDocument[] = [];

  for (const document of documents) {
    if (isViewerDocumentType(document.type)) attachments.push(document);
    else notes.push(document);
  }

  return { notes, attachments };
}

/**
 * 把附件按类型分组建列表。
 *
 * 不保留目录结构：附件的目录往往与笔记目录同构（`assets/`、`attachments/`），保留意味着
 * **同一个目录名在侧栏出现两次**（Notes 树一次、Attachments 区一次），点错是必然的；
 * 而「找图片」和「找 PDF」本来就是两种意图，按类型切正好对上。
 *
 * 组顺序由 core 的 `VIEWER_DOCUMENT_TYPES` 决定（**不是**按数据里出现的先后），每次渲染
 * 都一样；空组不显示。组内按名称排序（`localeCompare`，与 `buildFileTree` 同一套规则），
 * 同名时按相对路径兜底，让顺序**确定**而不依赖输入先后。
 */
export function buildAttachmentGroups(
  attachments: readonly IndexedDocument[]
): AttachmentGroup[] {
  const groups: AttachmentGroup[] = [];

  for (const type of VIEWER_DOCUMENT_TYPES) {
    // `filter` 已经返回新数组，可以就地排序 —— 不改动入参。
    const documents = attachments.filter((document) => document.type === type);
    if (documents.length === 0) continue;

    documents.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.relativePath.localeCompare(b.relativePath);
    });

    const nameCounts = new Map<string, number>();
    for (const document of documents) {
      nameCounts.set(document.name, (nameCounts.get(document.name) ?? 0) + 1);
    }

    groups.push({
      type,
      entries: documents.map((document) => ({
        document,
        directoryHint:
          (nameCounts.get(document.name) ?? 0) > 1 ? relativeDirectory(document.relativePath) : null
      }))
    });
  }

  return groups;
}

/** 相对路径里的目录部分；位于根目录时返回空串。 */
function relativeDirectory(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index < 0 ? '' : relativePath.slice(0, index);
}

/** 附件行上要显示的提取提示。 */
export type ExtractionNote = 'empty' | 'failed';

/**
 * 附件行该不该提示「文本提取」的结果 —— **只有两种状态会显示**。
 *
 * `'none'` 不提示：它在索引层同时表示「没有处理器认领这个类型」（图片）与「这一轮
 * 它没被引用」，两者都不该有提示。这正是合并这两个语义的收益 —— 渲染进程**不需要**
 * 知道哪些类型有处理器（否则等于把主进程的注册表复制一份，两份迟早不一致）。
 *
 * `'empty'`（真的没有文本，如扫描版 PDF）与 `'failed'`（本来可能有、读失败了）保留
 * 区别：前者是事实，后者是故障。判据放渲染层，因为「哪些状态值得提示」是界面决策。
 */
export function extractionNoteOf(document: IndexedDocument): ExtractionNote | null {
  return document.extractionStatus === 'empty' || document.extractionStatus === 'failed'
    ? document.extractionStatus
    : null;
}
