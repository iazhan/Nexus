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

/**
 * 侧栏与「删除文件」的两处接线。
 *
 * 为什么放在这一层而不是真机：右键菜单**本身**的行为归 `context-menu.test.tsx`，
 * 而「树上的行有没有把右键转成 `(路径, x, y)`」是纯接线，happy-dom 里几毫秒就能覆盖
 * 笔记行 / 附件行 / 没接回调三种形状。真机那一层只负责证明「右键真能弹出来、删完树真的少了」。
 *
 * 第二条（`revision` 重读）防的是一个具体的毛病：**文件删了、树里还在**。
 * `documentRevision` 此前只被标签页 / 图谱 / 插件几个面板消费，侧栏被跳过了。
 */
describe('工作区侧栏：右键删除入口与刷新', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    vi.restoreAllMocks();
  });

  /** 装上桥，并等挂载那次索引跑完。 */
  async function mountSidebar(options: {
    documents: IndexedDocument[];
    onFileContextMenu?: (filePath: string, x: number, y: number) => void;
  }): Promise<void> {
    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT, scanned: options.documents.length })),
      listIndexedDocuments: vi.fn(async () => options.documents)
    };

    await act(async () => {
      root.render(
        <WorkspaceSidebar
          rootPath="/vault"
          activeFilePath={null}
          onOpenFile={vi.fn()}
          onFileContextMenu={options.onFileContextMenu}
        />
      );
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector('.nexus-workspace-sidebar')?.getAttribute('data-phase') === 'ready') {
        return;
      }
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error(`侧栏没有进入 ready：${container.innerHTML}`);
  }

  /** 在某个选择器上派发右键，返回那个事件（用来断言 `defaultPrevented`）。 */
  function rightClick(selector: string, x = 40, y = 60): MouseEvent {
    const target = container.querySelector(selector);
    if (!target) throw new Error(`找不到 ${selector}`);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('笔记行右键上报绝对路径与视口坐标，并吃掉原生菜单', async () => {
    const onFileContextMenu = vi.fn();
    await mountSidebar({ documents: [doc('index.md')], onFileContextMenu });

    const event = rightClick('.nexus-sidebar-section[data-section="notes"] .nexus-tree-file', 40, 60);

    expect(onFileContextMenu).toHaveBeenCalledWith('/vault/index.md', 40, 60);
    // 不 `preventDefault` 的话系统菜单会叠在我们的菜单上。
    expect(event.defaultPrevented).toBe(true);
  });

  it('附件行右键同样上报', async () => {
    const onFileContextMenu = vi.fn();
    await mountSidebar({ documents: [doc('assets/logo.png')], onFileContextMenu });

    rightClick('.nexus-attachment-item', 10, 20);

    expect(onFileContextMenu).toHaveBeenCalledWith('/vault/assets/logo.png', 10, 20);
  });

  it('没接回调时不吃原生菜单 —— 别的地方用这个组件不该被改掉右键', async () => {
    await mountSidebar({ documents: [doc('index.md')] });

    const event = rightClick('.nexus-sidebar-section[data-section="notes"] .nexus-tree-file');
    expect(event.defaultPrevented).toBe(false);
  });

  /**
   * `revision` 变了才重读，**挂载那一次要跳过**。
   *
   * 不跳的话两个 effect 会抢：建索引那个还没 await 完，重读那个就先查了一次，
   * 拿到的是旧列表 —— 谁后 resolve 谁说了算，结果是随机的。
   * 所以这里同时钉两件事：挂载时只读一次；revision 变了才读第二次，且**用**了第二次的结果。
   */
  it('挂载只读一次列表，revision 变化才重读并采用新结果', async () => {
    const first = [doc('index.md')];
    // 新加的是**顶层**文件：默认展开只覆盖顶层目录，塞进 `notes/` 的话它会被折叠起来，
    // 那样断言的就是「目录展开策略」而不是「列表有没有重读」。
    const second = [doc('index.md'), doc('added.md')];
    let call = 0;
    const listIndexedDocuments = vi.fn(async () => {
      const list = call === 0 ? first : second;
      call += 1;
      return list;
    });

    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT, scanned: 2 })),
      listIndexedDocuments
    };

    await act(async () => {
      root.render(
        <WorkspaceSidebar rootPath="/vault" activeFilePath={null} onOpenFile={vi.fn()} revision={0} />
      );
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector('.nexus-workspace-sidebar')?.getAttribute('data-phase') === 'ready') break;
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(listIndexedDocuments).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('added.md');

    await act(async () => {
      root.render(
        <WorkspaceSidebar rootPath="/vault" activeFilePath={null} onOpenFile={vi.fn()} revision={1} />
      );
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.textContent?.includes('added.md')) break;
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(listIndexedDocuments).toHaveBeenCalledTimes(2);
    // 光「读了一次」不够 —— 读了不画，用户看到的还是旧树。
    expect(container.textContent).toContain('added.md');
  });
});

/**
 * 内联改名的**分支**：哪一行变成输入框、提交时带的是哪个路径。
 *
 * 输入框自己的键盘矩阵在 `inline-rename.test.tsx` 里，这里只验侧栏这一侧：
 * 判据用 `renamingPath` 去比对**绝对路径**（不是相对路径、不是名字）——
 * 用错一个，症状是「点了重命名，变成输入框的是另一行」。
 */
describe('工作区侧栏：内联改名', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { nexus?: unknown }).nexus;
    vi.restoreAllMocks();
  });

  async function mountSidebar(options: {
    documents: IndexedDocument[];
    renamingPath?: string | null;
    onRenameCommit?: (filePath: string, newName: string) => void;
    onRenameCancel?: () => void;
  }): Promise<void> {
    (window as unknown as { nexus: unknown }).nexus = {
      rebuildIndex: vi.fn(async () => ({ ...OK_RESULT, scanned: options.documents.length })),
      listIndexedDocuments: vi.fn(async () => options.documents)
    };

    await act(async () => {
      root.render(
        <WorkspaceSidebar
          rootPath="/vault"
          activeFilePath={null}
          onOpenFile={vi.fn()}
          renamingPath={options.renamingPath}
          onRenameCommit={options.onRenameCommit}
          onRenameCancel={options.onRenameCancel}
        />
      );
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector('.nexus-workspace-sidebar')?.getAttribute('data-phase') === 'ready') {
        return;
      }
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error(`侧栏没有进入 ready：${container.innerHTML}`);
  }

  function input(): HTMLInputElement {
    const element = container.querySelector<HTMLInputElement>('.nexus-tree-rename-input');
    if (!element) throw new Error('没找到内联改名输入框');
    return element;
  }

  function type(value: string): void {
    const element = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function press(key: string): void {
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  it('笔记行命中 renamingPath 时换成输入框，初值是文件名（含扩展名）', async () => {
    await mountSidebar({ documents: [doc('notes/dma.md')], renamingPath: '/vault/notes/dma.md' });

    expect(input().value).toBe('dma.md');
    // 那一行的按钮被替换掉，不是叠在上面 —— 叠着的话点一下会打开文件
    expect(
      container.querySelectorAll('.nexus-sidebar-section[data-section="notes"] .nexus-tree-file')
    ).toHaveLength(0);
  });

  it('附件行走同一个入口（D6：附件一起做）', async () => {
    await mountSidebar({ documents: [doc('assets/logo.png')], renamingPath: '/vault/assets/logo.png' });

    expect(input().value).toBe('logo.png');
    expect(container.querySelectorAll('.nexus-attachment-item')).toHaveLength(0);
  });

  it('路径对不上时一行都不换（用相对路径或名字比对就会错在这里）', async () => {
    await mountSidebar({ documents: [doc('notes/dma.md')], renamingPath: 'notes/dma.md' });

    expect(container.querySelector('.nexus-tree-rename-input')).toBeNull();
    expect(container.querySelectorAll('.nexus-tree-file')).toHaveLength(1);
  });

  it('renamingPath 为 null 时不画输入框（默认状态）', async () => {
    await mountSidebar({ documents: [doc('notes/dma.md')], renamingPath: null });

    expect(container.querySelector('.nexus-tree-rename-input')).toBeNull();
  });

  it('提交时把绝对路径与新名字一起上报', async () => {
    const onRenameCommit = vi.fn();
    await mountSidebar({
      documents: [doc('notes/dma.md')],
      renamingPath: '/vault/notes/dma.md',
      onRenameCommit
    });

    type('dma-2.md');
    press('Enter');

    // 路径是**绝对**路径：主进程要靠它做边界校验，相对路径过不去。
    expect(onRenameCommit).toHaveBeenCalledWith('/vault/notes/dma.md', 'dma-2.md');
  });

  it('Escape 只取消，不上报提交', async () => {
    const onRenameCommit = vi.fn();
    const onRenameCancel = vi.fn();
    await mountSidebar({
      documents: [doc('notes/dma.md')],
      renamingPath: '/vault/notes/dma.md',
      onRenameCommit,
      onRenameCancel
    });

    type('dma-2.md');
    press('Escape');

    expect(onRenameCancel).toHaveBeenCalledTimes(1);
    expect(onRenameCommit).not.toHaveBeenCalled();
  });
});
