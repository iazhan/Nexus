// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentTypeForPath, type IndexedDocument } from '@nexus/core';
import { WorkspaceSidebar } from '../src/workspace/WorkspaceSidebar.js';
import { localeManager } from '../src/platform.js';

/**
 * 侧栏**两段结构**的渲染（P3-09）。
 *
 * 为什么这一层要有用例：分类与分组的规则已经在 `attachments.test.ts` 里覆盖了，
 * 但「哪一段渲染什么」是**组件里的分支**（整块空 / 笔记空 / 附件空 / 两段都有），
 * 纯函数测不到。而真机用例（`apps/desktop/test/p3-09-attachments.test.ts`）
 * 一个文件只能启动一次 Electron、只跑一种工作区形状，覆盖不到空态。
 *
 * 所以这里用**打桩的 `window.nexus`** 把 IPC 换掉，只验渲染：快、能造任意输入形状。
 * 真机那一层负责证明「真实索引喂进来也是这个结果」。
 *
 * `apps/desktop/test/**` 与 `renderer/test/**` 都不进 typecheck，所以这里的类型
 * 只靠 esbuild 转译——写错了不会有人告诉你，注意别依赖编译器。
 */

// React 18+ 要求显式声明当前处于 act 环境，否则会刷警告。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只关心路径与类型，其余给固定值。 */
function doc(relativePath: string, overrides: Partial<IndexedDocument> = {}): IndexedDocument {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    id: 0,
    path: `/vault/${relativePath}`,
    relativePath,
    name,
    title: name.replace(/\.[^.]+$/, ''),
    type: documentTypeForPath(relativePath) ?? 'markdown',
    sizeBytes: 1,
    modifiedAtMs: 1,
    contentHash: 'x',
    extractionStatus: 'none',
    ...overrides
  };
}

const OK_RESULT = {
  scanned: 0,
  indexed: 0,
  skipped: 0,
  removed: 0,
  truncated: false,
  errors: [] as string[]
};

describe('工作区侧栏：笔记树 + 附件区', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenFile = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    // 单例：本文件里改过 locale 的用例必须还原，否则同进程里后面的用例会跟着变
    act(() => {
      localeManager.setLocale('en-US');
    });
    vi.restoreAllMocks();
  });

  /**
   * 渲染并等 effect 里的索引链跑完。
   *
   * 组件里的 effect 是 `void (async () => { await rebuildIndex(); await list() })()` ——
   * React 不会等它，所以 `await act(...)` 之后还要把微任务队列放干。
   *
   * 判据用 `data-phase="ready"` 而不是「有没有 `.nexus-sidebar-note`」：
   * **加载态也是 `.nexus-sidebar-note`**，按它等会在 `indexing` 就提前返回，
   * 断言随后失败、看起来却像「渲染错了」。
   */
  async function renderSidebar(documents: IndexedDocument[]): Promise<void> {
    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT, scanned: documents.length })),
      listIndexedDocuments: vi.fn(async () => documents)
    };

    await act(async () => {
      root.render(
        <WorkspaceSidebar rootPath="/vault" activeFilePath={null} onOpenFile={onOpenFile} />
      );
    });

    const isReady = () =>
      container.querySelector('.nexus-workspace-sidebar')?.getAttribute('data-phase') === 'ready';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (isReady()) return;
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error(`侧栏没有进入 ready：${container.innerHTML}`);
  }

  /** 把两段结构读成可断言的数据形状。 */
  function readSections() {
    return Array.from(container.querySelectorAll('.nexus-sidebar-section')).map((section) => ({
      section: section.getAttribute('data-section'),
      title: section.querySelector('.nexus-sidebar-section-title span:not(.nexus-sidebar-section-count)')
        ?.textContent,
      count: section.querySelector('.nexus-sidebar-section-count')?.textContent,
      emptyNote: section.querySelector('.nexus-sidebar-note')?.textContent ?? null,
      // 笔记段是目录、附件段是分组标题 —— 两者在 DOM 上都是「可折叠的一层」
      collapsible: Array.from(section.querySelectorAll('.nexus-tree-dir')).map(
        (el) => el.querySelector('.nexus-tree-name')?.textContent
      ),
      files: Array.from(section.querySelectorAll('.nexus-tree-file'))
        .filter((el) => !el.classList.contains('nexus-attachment-item'))
        .map((el) => el.querySelector('.nexus-tree-name')?.textContent),
      groups: Array.from(section.querySelectorAll('.nexus-attachment-group')).map((group) => {
        const row = group.parentElement as HTMLElement;
        return {
          label: group.querySelector('.nexus-tree-name')?.textContent,
          count: group.querySelector('.nexus-attachment-count')?.textContent,
          expanded: group.getAttribute('aria-expanded'),
          items: Array.from(row.querySelectorAll('.nexus-attachment-item')).map((item) => ({
            name: item.querySelector('.nexus-tree-name')?.textContent,
            hint: item.querySelector('.nexus-attachment-hint')?.textContent ?? null,
            note: item.querySelector('.nexus-attachment-note')?.textContent ?? null,
            size: item.querySelector('.nexus-attachment-size')?.textContent,
            title: item.getAttribute('title')
          }))
        };
      })
    }));
  }

  const click = (selector: string) => {
    const el = container.querySelector(selector);
    if (!el) throw new Error(`找不到 ${selector}`);
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  /**
   * 一份形状完整的工作区：笔记 + 三类附件 + 一个同名对。
   *
   * 组内顺序**只用 ASCII 名**来断言：`localeCompare` 不传 locale 时用运行时的默认
   * locale，而中英混排的顺序跟着操作系统走（本机 `zh-CN` 下汉字排在拉丁字母**前**，
   * `en-US` 下排在**后**）。中文文件名另有单独一条用例。
   */
  function mixedDocuments(): IndexedDocument[] {
    return [
      doc('index.md', { sizeBytes: 100 }),
      doc('notes/dma.md', { sizeBytes: 200 }),
      doc('assets/logo.png', { sizeBytes: 2048, modifiedAtMs: Date.UTC(2026, 8, 27, 6, 30) }),
      doc('logo.png', { sizeBytes: 512, modifiedAtMs: Date.UTC(2026, 8, 27, 6, 30) }),
      doc('cover.jpg', { sizeBytes: 1536, modifiedAtMs: Date.UTC(2026, 8, 27, 6, 30) }),
      doc('datasheet.pdf', { sizeBytes: 1024 * 1024, modifiedAtMs: 0 }),
      doc('spec.docx', { sizeBytes: 3000, modifiedAtMs: Date.UTC(2026, 8, 27, 6, 30) })
    ];
  }

  it('笔记进树、附件按类型分组，行内给出大小与同名提示', async () => {
    await renderSidebar(mixedDocuments());
    const sections = readSections();

    expect(sections.map((s) => s.section)).toEqual(['notes', 'attachments']);

    const [notes, attachments] = sections;
    expect(notes!.title).toBe('Notes');
    expect(notes!.count).toBe('2');
    expect(notes!.emptyNote).toBeNull();
    // 顶层目录默认展开：目录排在文件前，附件不进这一段
    expect(notes!.collapsible).toEqual(['notes']);
    expect(notes!.files).toEqual(['dma.md', 'index.md']);

    expect(attachments!.title).toBe('Attachments');
    expect(attachments!.count).toBe('5');
    expect(attachments!.emptyNote).toBeNull();
    // 组顺序由 VIEWER_DOCUMENT_TYPES 定死，与输入顺序无关
    expect(attachments!.groups.map((g) => g.label)).toEqual(['Image', 'PDF', 'DOCX']);

    const [images, pdfs, docxs] = attachments!.groups;
    expect(images!.count).toBe('3');
    // 两个 logo.png 同名 → 按相对路径兜底（'assets/…' < 'logo.png'，纯 ASCII，稳定）
    expect(images!.items.map((i) => [i.name, i.hint, i.size])).toEqual([
      ['cover.jpg', null, '1.5 KB'],
      ['logo.png', 'assets', '2 KB'],
      ['logo.png', 'root', '512 B']
    ]);
    // 没有同名的不给提示 —— 侧栏窄，每行挂目录前缀会把文件名挤掉
    expect(pdfs!.items.map((i) => [i.name, i.hint, i.size])).toEqual([
      ['datasheet.pdf', null, '1 MB']
    ]);
    expect(docxs!.items.map((i) => [i.name, i.hint, i.size])).toEqual([
      ['spec.docx', null, '2.9 KB']
    ]);
  });

  it('中文附件名原样显示，不参与跨语种顺序断言', async () => {
    // 单独一条：中英混排的先后跟着运行时 locale 走，把它放进主用例会让
    // 「断言顺序」变成「断言这台机器的 ICU」，在别的机器上红得莫名其妙。
    await renderSidebar([doc('原理图.png', { sizeBytes: 1536 })]);

    const [images] = readSections()[1]!.groups;
    expect(images!.items.map((i) => [i.name, i.hint, i.size])).toEqual([
      ['原理图.png', null, '1.5 KB']
    ]);
  });

  it('悬停提示给完整路径与修改时间；stat 失败时只有路径、不留空行', async () => {
    await renderSidebar(mixedDocuments());
    const [images, pdfs] = readSections()[1]!.groups;

    // 时间格式的形状而不是具体值：用例不该依赖跑测试的那台机器的时区
    expect(images!.items[0]!.title).toMatch(
      /^\/vault\/cover\.jpg\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    );
    // modifiedAtMs = 0 是「stat 失败」，不是 1970 年 —— 不要多出一个换行和一个假时间
    expect(pdfs!.items[0]!.title).toBe('/vault/datasheet.pdf');
  });

  /**
   * 提取提示（P3-10）。
   *
   * 为什么这一层要有用例：判据在 `extractionNoteOf()` 里（纯函数，`attachments.test.ts`
   * 覆盖），但「哪一行、显示成什么」是组件里的分支。而这条分支的**反面**才是重点 ——
   * `'extracted'` 与 `'none'` 都**不能**出现提示，那是两个不同的「没什么可说」。
   */
  it('提取提示只在 empty / failed 时出现：行内短标记，tooltip 给完整说明', async () => {
    await renderSidebar([
      doc('scan.pdf', { extractionStatus: 'empty', modifiedAtMs: 0 }),
      doc('broken.pdf', { extractionStatus: 'failed', modifiedAtMs: 0 }),
      doc('ok.pdf', { extractionStatus: 'extracted', modifiedAtMs: 0 }),
      doc('manual.pdf', { extractionStatus: 'none', modifiedAtMs: 0 }),
      doc('spec.docx', { extractionStatus: 'empty', modifiedAtMs: 0 })
    ]);

    const groups = readSections()[1]!.groups;
    expect(groups.map((g) => g.label)).toEqual(['PDF', 'DOCX']);
    const [pdfs, docxs] = groups;

    // 组内按文件名排序（纯 ASCII，顺序稳定）
    expect(pdfs!.items.map((i) => [i.name, i.note, i.title])).toEqual([
      ['broken.pdf', 'failed', '/vault/broken.pdf\nText extraction failed'],
      // `extracted` 是成功，不必说话；`none` 是「这一轮没被引用」或
      // 「这个类型没有处理器」—— 同样不该说话
      ['manual.pdf', null, '/vault/manual.pdf'],
      ['ok.pdf', null, '/vault/ok.pdf'],
      // 行内只放短标记（侧栏窄），完整说法在 tooltip 里
      ['scan.pdf', 'no text', '/vault/scan.pdf\nNo text extracted (scanned PDF?)']
    ]);
    expect(docxs!.items.map((i) => [i.name, i.note])).toEqual([['spec.docx', 'no text']]);
  });

  it('提取提示跟随语言', async () => {
    await renderSidebar([doc('scan.pdf', { extractionStatus: 'empty', modifiedAtMs: 0 })]);
    const note = () => readSections()[1]!.groups[0]!.items[0]!.note;

    expect(note()).toBe('no text');

    act(() => {
      localeManager.setLocale('zh-CN');
    });
    expect(note()).toBe('无文本');
  });

  it('点附件行打开文件，点分组标题只折叠、不打开', async () => {
    await renderSidebar(mixedDocuments());

    click('.nexus-attachment-item');
    expect(onOpenFile).toHaveBeenCalledWith('/vault/cover.jpg');

    // 分组标题是「可折叠的一层」，点它不该顺手打开组里第一个文件
    onOpenFile.mockClear();
    click('.nexus-attachment-group');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('折叠状态按组独立：收起图片组不影响 PDF 组', async () => {
    await renderSidebar(mixedDocuments());

    const groupState = () =>
      readSections()[1]!.groups.map((g) => [g.label, g.expanded, g.items.length]);

    // 默认全部展开 —— 存「收起」而不是「展开」，所以不需要「首次写入默认值」的 effect
    expect(groupState()).toEqual([
      ['Image', 'true', 3],
      ['PDF', 'true', 1],
      ['DOCX', 'true', 1]
    ]);

    click('.nexus-attachment-group');
    expect(groupState()).toEqual([
      ['Image', 'false', 0],
      ['PDF', 'true', 1],
      ['DOCX', 'true', 1]
    ]);

    click('.nexus-attachment-group');
    expect(groupState()).toEqual([
      ['Image', 'true', 3],
      ['PDF', 'true', 1],
      ['DOCX', 'true', 1]
    ]);
  });

  it('一个文档都没有时整块空，两段都不渲染', async () => {
    await renderSidebar([]);

    expect(container.querySelectorAll('.nexus-sidebar-section')).toHaveLength(0);
    expect(container.textContent).toContain('No documents in this workspace.');
  });

  it('只有附件时两段都在，笔记段显示自己的空态', async () => {
    await renderSidebar([doc('assets/logo.png')]);
    const sections = readSections();

    expect(sections.map((s) => s.section)).toEqual(['notes', 'attachments']);
    expect(sections[0]!.emptyNote).toBe('No notes in this workspace.');
    expect(sections[0]!.count).toBe('0');
    expect(sections[1]!.groups.map((g) => g.label)).toEqual(['Image']);
  });

  it('只有笔记时附件段显示自己的空态，且不出现任何分组', async () => {
    await renderSidebar([doc('index.md')]);
    const sections = readSections();

    expect(sections.map((s) => s.section)).toEqual(['notes', 'attachments']);
    expect(sections[1]!.emptyNote).toBe('No attachments in this workspace.');
    expect(sections[1]!.count).toBe('0');
    expect(sections[1]!.groups).toEqual([]);
  });

  it('区标题与组名跟随语言，没有硬编码英文', async () => {
    await renderSidebar(mixedDocuments());

    const titles = () =>
      readSections().map((s) => [s.title, s.collapsible, s.groups.map((g) => g.label)]);

    // 单例默认 en-US
    expect(titles()[0]![0]).toBe('Notes');

    act(() => {
      localeManager.setLocale('zh-CN');
    });
    // 组名复用 `document.type.*`，所以这里同时验了「没有另写一份类型名」
    expect(titles()).toEqual([
      ['笔记', ['notes'], []],
      ['附件', ['图片', 'PDF', 'DOCX'], ['图片', 'PDF', 'DOCX']]
    ]);
  });
});
