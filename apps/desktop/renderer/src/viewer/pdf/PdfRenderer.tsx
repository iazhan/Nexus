import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { formatDocumentCitation, toAssetUrl } from '@nexus/core';
import { useLocale } from '../../hooks.js';
import { settings } from '../../platform.js';
import { parsePdfPageLayout, type PdfPageLayout } from '../../settings/preference-specs.js';
import type { ViewerRendererProps } from '../types.js';
import PdfPage, { type PageSize } from './PdfPage.js';
import PdfSidebar, { type PdfSidebarTab } from './PdfSidebar.js';
import type { PdfOutlineItem } from './PdfOutline.js';
import {
  A4_FALLBACK_SIZE,
  BASE_SCALE,
  clampZoom,
  fitWidthZoom,
  flattenOutline,
  pageAtScrollOffset,
  pageFractionAt,
  scrollOffsetForPage,
  scrollTopForAnchor,
  stepZoom,
  wheelZoomFactor,
  zoomPercent,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  type PageSpan,
  type RawOutlineNode
} from './pdf-layout.js';
import { PDF_DOCUMENT_OPTIONS, pdfjsLib } from './pdf-runtime.js';

/**
 * PDF Viewer（P3-07 起；连续滚动 / 缩放 / 缩略图 / 大纲是后加的）。
 *
 * ## 视图状态与设置项的分界
 *
 * **翻页方式落盘**（`viewer.pdfPageLayout`）：它是「我读 PDF 一直想这么读」的习惯，
 * 与打开哪一份无关，所以进设置页、跨会话记住，工具栏上的切换按钮是它的快捷入口。
 *
 * **缩放、侧栏开关与当前标签页不落盘**：那是这一次阅读的临时状态。判据是
 * 「每次打开都要重设一遍吗」—— 要，就不该假装它是偏好。图谱面板的缩放/平移同理。
 *
 * ## 三个 effect 各自负责一件事，且都必须能安全取消
 *
 * - 加载：`loadingTask.destroy()` 会连同已解析的文档一起释放 worker 资源。
 * - 渲染：在 `PdfPage` 里，`renderTask.cancel()` 让上一页的绘制不再往 canvas 上写。
 * - 选区：监听 document 的 `mouseup`（拖到容器外松手也收得到），再判选区是否
 *   整段落在正文区里。
 *
 * ## 换文档靠宿主的 key，不靠这里
 *
 * 组件身份由外壳的 `key={doc.path}` 决定，所以**不需要处理「换文档」** ——
 * 换一份 PDF 就是换一个组件实例。这消掉了整类「上一份文档的页数/当前页挂到下一份上」
 * 的问题。**但 `#page=` 锚点不同**：同一份 PDF 已经开着时宿主只换 `doc.page`、
 * 不换 key，所以那一个值要由 effect 接住。
 *
 * ## 连续滚动为什么只渲染可见页
 *
 * 一份 300 页的 PDF 全部渲染意味着 300 个 canvas 位图同时驻留 —— 打开就会卡死。
 * 所以每一页各自用 `IntersectionObserver` 判断自己是否进入视野，`PdfPage` 负责这件事。
 * 代价是快速滚动时可能有一瞬空白，那是刻意的取舍。
 *
 * 未渲染的页用**第一页的尺寸**撑出占位高度。同一份 PDF 里混着不同纸张尺寸是常见的，
 * 那种情况下占位高度会偏 —— 但偏的只是「还没画出来的那一页有多高」，
 * 页面一旦渲染就用真实尺寸替换（见 `PdfPage` 的 `rendered`）。
 *
 * ## 缩放的两条路：按钮对齐页首，滚轮对准光标
 *
 * 缩放后页面高度全变了，旧的滚动位置必然偏，所以两者都要重新对齐，但**对齐的目标不同**：
 *
 * - `−/+`、适合宽度**没有光标**，对齐到当前页的页首（`scrollToPage`）。
 * - Ctrl / Cmd + 滚轮**带着光标**，要把光标下那一点放回原处。光标下的内容坐标由
 *   `pageFractionAt` 按**实测的页几何**记下来，缩放后重新落回同一相对位置。
 *   **不能用「旧位置 × 比例」**：页与页之间的 `gap` 是固定像素、不随缩放变，误差会随
 *   页数累积 —— 第 200 页上按一格就能偏出整整一页。
 *
 * 滚轮那条路不能在自己的处理器里当场写 `scrollTop`（那时新页高还没进 DOM），所以把锚点
 * 交给 `pendingAnchorRef`，由对齐 effect 在下一帧落地。
 *
 * 纯滚轮留给滚动；**按着修饰键就一定要 `preventDefault`**，连「已经到顶、不再缩放」那几次
 * 也要拦 —— 否则 Electron 会把它当成整个界面的缩放。
 *
 * ## 侧栏按钮叫「导航」
 *
 * 它开关的是一个含「缩略图 / 大纲」两个标签页的面板，所以取**容器**的名字。写成第一项内容的
 * 名字（曾经叫「缩略图」）就是名实不符 —— 用户点「缩略图」却看见两样东西。
 * **别给它加 `aria-label`**：可见文字本身就是可访问名，另挂一个不含可见文字的名字会违反
 * WCAG 2.5.3，语音控制按可见文字点不到。开合状态写在 `aria-pressed` 上。
 */

/** 复制引用的三种结果，驱动按钮文案与 `data-copy-state`。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** 滚轮缩放的锚点：光标压着的那一点，在缩放前的几何里是哪一页的哪个相对位置。 */
interface PdfZoomAnchor {
  readonly pageNumber: number;
  readonly fraction: number;
  /** 光标在 stage 视口内的 y 偏移 —— 缩放后这一点要回到同一个位置。 */
  readonly cursorOffset: number;
}

const PdfRenderer: React.FC<ViewerRendererProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [pageNumber, setPageNumber] = useState(doc.page ?? 1);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [layout, setLayout] = useState<PdfPageLayout>(() =>
    parsePdfPageLayout(settings.get('viewer.pdfPageLayout'))
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<PdfSidebarTab>('thumbnails');
  const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([]);
  const [pageSize, setPageSize] = useState<PageSize | null>(null);
  const [quote, setQuote] = useState('');
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // 页码与缩放的输入草稿。
  //
  // **必须有草稿，不能直接受控于 `pageNumber` / `zoom`**：输入「12」的过程中会先出现
  // 「1」，直接写回去就会跳到第 1 页 —— 用户看到的是「输入框自己在跟我打架」。
  // 草稿在失焦 / 回车时才提交，`commit*` 负责钳制与回退。
  const [pageDraft, setPageDraft] = useState(() => String(doc.page ?? 1));
  const [zoomDraft, setZoomDraft] = useState(() => zoomPercent(ZOOM_DEFAULT));

  const pageInputRef = useRef<HTMLInputElement | null>(null);
  const zoomInputRef = useRef<HTMLInputElement | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  // 同一个元素存两份：ref 给事件与测量（不需要重渲染），state 给子组件（要触发重新观察）
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const attachStage = useCallback((element: HTMLDivElement | null) => {
    stageRef.current = element;
    setStageElement(element);
  }, []);

  // 镜像最新的 layout / pageNumber，给那些不该因为它们变化而重跑的 effect 用。
  // `scrollToPage` 若把 layout 写进依赖，`#page=` 那个 effect 会在每次切布局时
  // 重新执行一遍，把用户翻到的页码顶回锚点页。
  const layoutRef = useRef(layout);
  const pageNumberRef = useRef(pageNumber);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    pageNumberRef.current = pageNumber;
  }, [pageNumber]);

  // 滚轮那条路要拿到「此刻的倍率」但不想每次缩放都重挂监听，所以镜像一份。
  // **滚轮处理器会同步写它**（不等 React）：一帧里连滚两格时，第二格必须基于第一格的
  // 结果算，否则两次都从旧值出发，连滚两格只放大一格。
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  /**
   * 滚轮缩放待落地的锚点。
   *
   * 不在 `wheel` 处理器里当场写 `scrollTop`：那一刻新的页高还没进 DOM，量到的还是旧几何。
   * 记下「光标下那一点在哪一页的哪个相对位置」，交给下面那个「缩放后对齐」的 effect
   * 在下一帧落地。
   */
  const pendingAnchorRef = useRef<PdfZoomAnchor | null>(null);

  // 滚轮监听挂在整个阅读器上（见下面那个 effect），所以这里也要一份元素引用。
  // 用 state 而不是纯 ref：`null → 元素` 这一次变化必须触发那个 effect 重新挂监听。
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);

  // 外部改了页码 / 缩放（滚动、翻页按钮、缩略图、大纲）时，草稿要跟上 ——
  // 但**用户正在这个框里打字时不跟**：输入「12」会先经过「1」，跟上就等于把用户的输入
  // 打回当前页，手感上像输入框在跟人打架。
  useEffect(() => {
    if (document.activeElement === pageInputRef.current) return;
    setPageDraft(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    if (document.activeElement === zoomInputRef.current) return;
    setZoomDraft(zoomPercent(zoom));
  }, [zoom]);

  // ── 设置 → 翻页方式 ───────────────────────────────────────────────────
  useEffect(
    () =>
      settings.subscribe('viewer.pdfPageLayout', () => {
        setLayout(parsePdfPageLayout(settings.get('viewer.pdfPageLayout')));
      }),
    []
  );

  // ── 加载文档 ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument({
      url: toAssetUrl(doc.path),
      ...PDF_DOCUMENT_OPTIONS
    });

    loadingTask.promise.then(
      (loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdfDocument(loaded);
        // 第一页的尺寸用来给连续模式的占位高度定基准。取不到就算了 ——
        // 回落到 A4 占位，而不是让整条列表高度为 0（那会让所有页叠在一起）。
        void loaded.getPage(1).then(
          (first) => {
            if (cancelled) return;
            const viewport = first.getViewport({ scale: 1 });
            setPageSize({ width: viewport.width, height: viewport.height });
          },
          () => undefined
        );
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );

    return () => {
      cancelled = true;
      // 在途的加载也要掐断：`destroy` 对已完成的 task 是幂等的。
      void loadingTask.destroy();
    };
  }, [doc.path]);

  // ── 大纲 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDocument) return;

    let cancelled = false;
    void (async () => {
      try {
        const raw = (await pdfDocument.getOutline()) as RawOutlineNode[] | null;
        const flat = flattenOutline(raw);

        const items: PdfOutlineItem[] = [];
        for (const entry of flat) {
          if (cancelled) return;
          const page = await destinationPage(pdfDocument, entry.dest);
          // 解析不出页码的条目直接丢掉：画出来点了不动，比不画更让人困惑。
          if (page !== null) items.push({ title: entry.title, depth: entry.depth, page });
        }
        if (!cancelled) setOutline(items);
      } catch {
        // 没有大纲、或大纲损坏都不是错误 —— 侧栏给空态就够了，正文照常可读。
        if (!cancelled) setOutline([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  // ── 页码钳制 ──────────────────────────────────────────────────────────
  // 锚点页码可能超出这份 PDF 的页数（引用写的时候是另一份文件、或文件被换过）。
  // 不钳住的话渲染 effect 会 reject，界面变成「加载失败」—— 而它其实打开成功了。
  useEffect(() => {
    if (!pdfDocument) return;
    setPageNumber((current) => Math.min(Math.max(1, current), pdfDocument.numPages));
  }, [pdfDocument]);

  const scrollToPage = useCallback(
    (target: number, smooth: boolean): void => {
      const total = pdfDocument?.numPages ?? 0;
      const clamped = Math.min(Math.max(1, target), Math.max(1, total));
      setPageNumber(clamped);

      if (layoutRef.current !== 'continuous') return;
      const stage = stageRef.current;
      // 查 DOM 而不是维护一张 ref 表：页元素由 `data-page-number` 自己标识，
      // 多一张表就多一处「什么时候该删」的问题。
      const element = stage?.querySelector<HTMLElement>(
        `.nexus-pdf-page[data-page-number="${clamped}"]`
      );
      if (!stage || !element) return;
      stage.scrollTo({
        top: scrollOffsetForPage(element.offsetTop),
        behavior: smooth ? 'smooth' : 'auto'
      });
    },
    [pdfDocument]
  );

  // ── `#page=` 锚点 ─────────────────────────────────────────────────────
  // 宿主换掉 doc.page 就是「翻到这一页」。同一份 PDF 已开着时 store 只更新这个值、
  // 不换 key，所以组件不重挂载 —— 变化必须由这里接住。
  useEffect(() => {
    if (!pdfDocument || doc.page === null) return;
    scrollToPage(doc.page, false);
  }, [doc.page, pdfDocument, scrollToPage]);

  // ── 切布局：DOM 整个换掉，滚动位置归零，重新对齐到当前页 ────────────────
  useEffect(() => {
    if (!pdfDocument) return;
    const target = pageNumberRef.current;
    const frame = requestAnimationFrame(() => scrollToPage(target, false));
    return () => cancelAnimationFrame(frame);
  }, [layout, pdfDocument, scrollToPage]);

  // ── 缩放后重新对齐 ────────────────────────────────────────────────────
  // 页高变了，按旧尺寸算出来的滚动位置会偏。等新尺寸落到 DOM 上（下一帧）再对齐。
  //
  // 两条路在这里分岔：**滚轮缩放带着光标**，要把光标下那一点放回原处；`−/+` 与
  // 适合宽度没有光标，对齐到当前页的页首。滚轮那条路必须走这里、不能在处理器里当场写
  // —— 新的页高要到这一帧才量得到。
  const previousZoom = useRef(zoom);
  useEffect(() => {
    if (previousZoom.current === zoom) return;
    previousZoom.current = zoom;

    const stage = stageRef.current;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;

    const frame = requestAnimationFrame(() => {
      if (anchor !== null && stage !== null) {
        const page = stage.querySelector<HTMLElement>(
          `.nexus-pdf-page[data-page-number="${anchor.pageNumber}"]`
        );
        if (page !== null) {
          stage.scrollTop = scrollTopForAnchor(
            page.offsetTop,
            page.offsetHeight,
            anchor.fraction,
            anchor.cursorOffset
          );
          return;
        }
      }
      // 单页模式没有「下一页」可对齐，页首对齐只对连续模式有意义。
      if (layoutRef.current !== 'continuous') return;
      scrollToPage(pageNumberRef.current, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [zoom, scrollToPage]);

  // ── Ctrl / Cmd + 滚轮缩放 ─────────────────────────────────────────────
  // **必须原生监听并 `preventDefault`**，两个理由：
  // 1. React 的 `onWheel` 挂在根容器上且是 passive 的，里面调 `preventDefault` 不生效；
  // 2. Ctrl+滚轮在 Electron 里默认是**整个界面**的缩放（preload 用 `webFrame.setZoomFactor`
  //    管界面缩放），不拦的话用户按 Ctrl+滚轮会把 Nexus 窗口一起放大，而 PDF 一动不动。
  //    这也是监听挂在**整个阅读器**而不是只挂 stage 的原因 —— 光标停在工具栏 / 侧栏上
  //    时同样得拦住。
  //
  // 纯滚轮留给滚动 —— stage 是可滚动容器，连续模式下更是。要修饰键的另一个好处是
  // 触控板双指捏合在 Chromium 里就是 `wheel` + `ctrlKey: true`，这一条顺带把它开了。
  useEffect(() => {
    if (!viewerElement) return;

    /** 光标在正文区里时记下它压着的那一点；不在（工具栏 / 侧栏上）返回 `null`。 */
    const anchorFrom = (event: WheelEvent): PdfZoomAnchor | null => {
      const stage = stageRef.current;
      const target = event.target;
      if (stage === null || !(target instanceof Node) || !stage.contains(target)) return null;

      const cursorOffset = event.clientY - stage.getBoundingClientRect().top;
      const spans: PageSpan[] = Array.from(
        stage.querySelectorAll<HTMLElement>('.nexus-pdf-page'),
        (page) => ({
          pageNumber: Number(page.dataset.pageNumber ?? 0),
          top: page.offsetTop,
          height: page.offsetHeight
        })
      );
      const hit = pageFractionAt(spans, stage.scrollTop + cursorOffset);
      return hit === null ? null : { ...hit, cursorOffset };
    };

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      // 只要按着修饰键就拦，**包括「已经到顶、不再缩放」那几次** —— 那几次不拦的话，
      // 用户会看到「滚到上限之后界面开始放大」。
      event.preventDefault();

      const previous = zoomRef.current;
      const next = clampZoom(previous * wheelZoomFactor(event.deltaY));
      if (next === previous) return;

      // 同步写回，不等 React：一帧里连滚两格时，第二格必须基于第一格的结果算。
      zoomRef.current = next;
      pendingAnchorRef.current = anchorFrom(event);
      setZoom(next);
    };

    viewerElement.addEventListener('wheel', onWheel, { passive: false });
    return () => viewerElement.removeEventListener('wheel', onWheel);
  }, [viewerElement]);

  // ── 连续滚动 → 当前页 ─────────────────────────────────────────────────
  useEffect(() => {
    if (layout !== 'continuous') return;
    const stage = stageElement;
    if (!stage) return;

    let pending = false;
    const handleScroll = (): void => {
      // 滚动事件一帧能来很多次，量 offsetTop 会强制布局 —— 一帧算一次就够。
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const pages = stage.querySelectorAll<HTMLElement>('.nexus-pdf-page');
        const offsets = Array.from(pages, (element) => element.offsetTop);
        setPageNumber(pageAtScrollOffset(offsets, stage.scrollTop));
      });
    };

    stage.addEventListener('scroll', handleScroll, { passive: true });
    return () => stage.removeEventListener('scroll', handleScroll);
  }, [layout, stageElement]);

  // ── 选区 → 引用 ───────────────────────────────────────────────────────
  useEffect(() => {
    const handleMouseUp = (): void => {
      const selection = window.getSelection();
      const container = stageRef.current;
      const text = selection?.toString() ?? '';

      // 选区必须**整段落在正文区里**。跨到工具栏或侧栏的选区不是「选中了这段原文」，
      // 拿它生成引用会得到半截界面文字 —— 而那种引用看起来完全正常。
      const within = (node: Node | null): boolean =>
        node !== null && container !== null && (node === container || container.contains(node));
      const isInside =
        text.trim().length > 0 &&
        within(selection?.anchorNode ?? null) &&
        within(selection?.focusNode ?? null);

      setQuote(isInside ? text : '');
      setCopyState('idle');
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const citation = useMemo(
    () =>
      quote.trim().length === 0
        ? ''
        : formatDocumentCitation({
            quote,
            targetPath: doc.path,
            baseDirectory: doc.citationBase,
            page: pageNumber
          }),
    [quote, doc.path, doc.citationBase, pageNumber]
  );

  const handleCopyCitation = useCallback((): void => {
    const copyText = window.nexus?.copyText;
    if (citation.length === 0 || !copyText) return;
    // 失败必须可见：剪贴板被别的程序占着时用户按了没反应，会以为「这个按钮是摆设」。
    void copyText(citation).then(
      (ok) => setCopyState(ok ? 'copied' : 'failed'),
      () => setCopyState('failed')
    );
  }, [citation]);

  const goToPreviousPage = useCallback((): void => {
    scrollToPage(pageNumberRef.current - 1, true);
  }, [scrollToPage]);

  const goToNextPage = useCallback((): void => {
    scrollToPage(pageNumberRef.current + 1, true);
  }, [scrollToPage]);

  const commitPageDraft = useCallback((): void => {
    const parsed = Number.parseInt(pageDraft, 10);
    if (!Number.isFinite(parsed)) {
      // 空串或只剩符号：回退到当前页，而不是当成第 1 页 —— 手滑清空输入框不该跳页
      setPageDraft(String(pageNumberRef.current));
      return;
    }
    const total = pdfDocument?.numPages ?? 0;
    const clamped = Math.min(Math.max(1, parsed), Math.max(1, total));
    // 手动写回草稿：目标页恰好等于当前页时 `pageNumber` 不变，上面那个同步 effect 不会触发，
    // 草稿会停在越界值上（输入 999 被钳到第 5 页，框里却还显示 999）。
    setPageDraft(String(clamped));
    scrollToPage(clamped, true);
  }, [pageDraft, pdfDocument, scrollToPage]);

  const commitZoomDraft = useCallback((): void => {
    const parsed = Number.parseInt(zoomDraft, 10);
    if (!Number.isFinite(parsed)) {
      setZoomDraft(zoomPercent(zoom));
      return;
    }
    // 同一个理由：输入 500 被钳到 300% 之后，框里要显示 300 而不是 500
    const clamped = clampZoom(parsed / 100);
    setZoomDraft(zoomPercent(clamped));
    setZoom(clamped);
  }, [zoomDraft, zoom]);

  /**
   * 两个草稿框共用的键盘处理。
   *
   * **Escape 必须 `preventDefault()`**：不拦的话这个键会冒泡到全局快捷键，
   * 用户想「取消这次输入」却把别的面板一起关掉了。
   */
  const draftKeyDown =
    (commit: () => void, reset: () => void) =>
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        reset();
      }
    };

  const applyZoom = useCallback((next: number): void => {
    setZoom(clampZoom(next));
  }, []);

  const fitToWidth = useCallback((): void => {
    const stage = stageRef.current;
    if (!stage) return;
    // `clientWidth` 已经不含滚动条，但要扣掉左右内边距才是真正能放页面的宽度。
    // `getComputedStyle` 在还没有布局时会给空字符串 —— `parseFloat` 于是得到 NaN，
    // 直接算下去会让缩放变成 NaN（`clampZoom` 会兜住，但兜住的是 100%，不是适合宽度）。
    const style = window.getComputedStyle(stage);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const available = stage.clientWidth - (Number.isFinite(padding) ? padding : 0);
    setZoom(fitWidthZoom(pageSize?.width ?? A4_FALLBACK_SIZE.width, available));
  }, [pageSize]);

  const toggleLayout = useCallback((): void => {
    // 写回设置而不是只改本地 state：工具栏按钮与设置页是同一个值的两个入口，
    // 只改本地的话在设置页里看不到变化，而用户会以为「设置没生效」。
    settings.set(
      'viewer.pdfPageLayout',
      layoutRef.current === 'continuous' ? 'single' : 'continuous'
    );
  }, []);

  if (failed) {
    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{t('viewer.pdf.loadError')}</span>
          <p className="error-description nexus-pdf-error-path">{doc.path}</p>
        </div>
      </div>
    );
  }

  const totalPages = pdfDocument?.numPages ?? 0;
  const scale = BASE_SCALE * zoom;
  const estimatedSize = pageSize ?? A4_FALLBACK_SIZE;
  const continuous = layout === 'continuous';

  return (
    <div className="nexus-pdf-viewer" ref={setViewerElement} data-layout={layout}>
      <div className="nexus-pdf-toolbar">
        <button
          type="button"
          className="nexus-pdf-sidebar-button"
          aria-pressed={sidebarOpen}
          title={t('viewer.pdf.toggleSidebar')}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {t('viewer.pdf.navigation')}
        </button>

        <span className="nexus-pdf-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="nexus-pdf-page-button"
          data-page-nav="previous"
          onClick={goToPreviousPage}
          disabled={pageNumber <= 1}
        >
          {t('viewer.pdf.previousPage')}
        </button>
        <span className="nexus-pdf-page-indicator">
          {/* 页码可直接改：输入框只收数字，回车或失焦提交，Escape 取消。 */}
          <input
            ref={pageInputRef}
            type="text"
            inputMode="numeric"
            className="nexus-pdf-page-input"
            aria-label={t('viewer.pdf.pageInputLabel')}
            value={pageDraft}
            disabled={totalPages === 0}
            onChange={(event) => setPageDraft(event.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitPageDraft}
            onKeyDown={draftKeyDown(commitPageDraft, () =>
              setPageDraft(String(pageNumberRef.current))
            )}
          />
          <span className="nexus-pdf-page-total">
            {t('viewer.pdf.pageTotal', { total: String(totalPages) })}
          </span>
        </span>
        <button
          type="button"
          className="nexus-pdf-page-button"
          data-page-nav="next"
          onClick={goToNextPage}
          disabled={totalPages === 0 || pageNumber >= totalPages}
        >
          {t('viewer.pdf.nextPage')}
        </button>

        <span className="nexus-pdf-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="nexus-pdf-zoom-button"
          aria-label={t('viewer.pdf.zoomOut')}
          title={t('viewer.pdf.zoomOut')}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => applyZoom(stepZoom(zoom, -1))}
        >
          −
        </button>
        {/* 缩放比例也可直接改。`%` 画在框外 —— 塞进 `value` 的话每次改数字都要先删掉它。 */}
        <input
          ref={zoomInputRef}
          type="text"
          inputMode="numeric"
          className="nexus-pdf-zoom-level"
          aria-label={t('viewer.pdf.zoomLevelLabel')}
          value={zoomDraft}
          onChange={(event) => setZoomDraft(event.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitZoomDraft}
          onKeyDown={draftKeyDown(commitZoomDraft, () => setZoomDraft(zoomPercent(zoom)))}
        />
        <span className="nexus-pdf-zoom-suffix" aria-hidden="true">
          %
        </span>
        <button
          type="button"
          className="nexus-pdf-zoom-button"
          aria-label={t('viewer.pdf.zoomIn')}
          title={t('viewer.pdf.zoomIn')}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => applyZoom(stepZoom(zoom, 1))}
        >
          +
        </button>
        <button type="button" className="nexus-pdf-fit-button" onClick={fitToWidth}>
          {t('viewer.pdf.fitWidth')}
        </button>

        <span className="nexus-pdf-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="nexus-pdf-layout-button"
          data-layout={layout}
          title={continuous ? t('viewer.pdf.switchToSingle') : t('viewer.pdf.switchToContinuous')}
          onClick={toggleLayout}
        >
          {t(continuous ? 'viewer.pdf.layoutContinuous' : 'viewer.pdf.layoutSingle')}
        </button>
      </div>

      <div className="nexus-pdf-body">
        {sidebarOpen && pdfDocument && (
          <PdfSidebar
            tab={sidebarTab}
            onTabChange={setSidebarTab}
            pdfDocument={pdfDocument}
            totalPages={totalPages}
            activePage={pageNumber}
            outline={outline}
            onSelectPage={(page) => scrollToPage(page, true)}
          />
        )}

        <div className="nexus-pdf-stage" ref={attachStage}>
          {pdfDocument === null && (
            <div className="nexus-state-container">
              <div className="nexus-loading-spinner" />
              <p className="nexus-state-text">{t('viewer.pdf.loading')}</p>
            </div>
          )}
          <div className="nexus-pdf-pages">
            {pdfDocument !== null &&
              (continuous
                ? Array.from({ length: totalPages }, (_, index) => (
                    <PdfPage
                      key={index + 1}
                      pdfDocument={pdfDocument}
                      pageNumber={index + 1}
                      scale={scale}
                      estimatedSize={estimatedSize}
                      scrollRoot={stageElement}
                    />
                  ))
                : (
                    <PdfPage
                      key="single"
                      pdfDocument={pdfDocument}
                      pageNumber={pageNumber}
                      scale={scale}
                      estimatedSize={estimatedSize}
                      scrollRoot={stageElement}
                      eager
                    />
                  ))}
          </div>
        </div>
      </div>

      {/* 只在有选区时出现 —— 没有选区时它没有任何可做的动作，占着位置只会让
          「翻页」这个主要动作被挤下去。 */}
      {citation.length > 0 && (
        <div className="nexus-pdf-citation" data-copy-state={copyState}>
          <code className="nexus-pdf-citation-text">{citation}</code>
          <button type="button" className="nexus-pdf-copy-button" onClick={handleCopyCitation}>
            {t(copyLabelKey(copyState))}
          </button>
        </div>
      )}
      <div className="nexus-pdf-caption">
        <span className="nexus-pdf-name">{doc.name}</span>
      </div>
    </div>
  );
};

function copyLabelKey(state: CopyState): string {
  if (state === 'copied') return 'viewer.pdf.copied';
  if (state === 'failed') return 'viewer.pdf.copyFailed';
  return 'viewer.pdf.copyCitation';
}

/**
 * 大纲项的 `dest` → 页码（1 起）。解不出来返回 `null`。
 *
 * 两种目标形状都要认：**显式目标**是一个数组，第一项是页面引用（`{ num, gen }`）；
 * **命名目标**是一个字符串，要先 `getDestination` 换回数组。只认数组的话，
 * 用命名目标写的 PDF（Acrobat 的默认导出就是）会整份没有大纲。
 *
 * 三层 `try` 只包一件事：**任何一步失败都当作「这一条解不出来」**，而不是让整份大纲
 * 因为一条坏条目而空掉。
 */
async function destinationPage(
  pdfDocument: PDFDocumentProxy,
  dest: unknown
): Promise<number | null> {
  try {
    const explicit =
      typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;

    const ref = explicit[0];
    if (ref === null || typeof ref !== 'object') return null;

    const index = await pdfDocument.getPageIndex(ref as Parameters<
      PDFDocumentProxy['getPageIndex']
    >[0]);
    return index + 1;
  } catch {
    return null;
  }
}

export default PdfRenderer;
