import React, { useCallback, useEffect, useRef, useState } from 'react';
import { hasUnsavedChanges, type WorkspaceDocument } from './store.js';
import { useLocale } from '../hooks.js';

export interface TabBarProps {
  documents: readonly WorkspaceDocument[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /**
   * 新建一份未命名文档。
   *
   * 与 `Ctrl+N`、菜单「文件 → 新建」是**同一条命令**（`new-file`），不是这里另开的一条路 ——
   * 三个入口给同一个动作，文案也必须同源，否则用户会以为是三件不同的事。
   */
  onCreate: () => void;
}

/**
 * 多标签页栏。
 *
 * 只渲染「打开了几个文档」这一件事，文档状态全从 props 来 ——
 * 它自己只持有一件状态：**标签是否被挤到看不见了**（`overflow`）。
 *
 * P3-05 起两类文档共用这一条栏：可编辑 Markdown 与只读附件（pdf / docx / 图片）。
 * 它们**必须**在同一个列表里，否则「打开了一个 PDF」在界面上没有任何痕迹 ——
 * 而用户明明刚双击了它。区分信息由文件名自带（`stm32.pdf` vs `stm32.md`），
 * 脏点则天然只出现在可编辑文档上（附件的 saveState 恒为 `readonly`）。
 *
 * **只有一个文档时也渲染。** 此前是 `<= 1` 直接 `return null`，理由是「占一行高度但信息量为零」；
 * 改成常驻之后，编辑区不会因为开了第二个文档、或关到只剩一个而突然多出/少掉一行。
 * 代价是单文档时白占一行 —— 这是取舍，不是遗漏。
 *
 * **零个文档才不渲染**：那时没有可点的东西，而主区本来就在画空态。右侧那个 `+` 也跟着不画，
 * 这是刻意的 —— 空栏里孤零零一个按钮，而新建本来就有快捷键和菜单两条路。
 *
 * 脏点读 `hasUnsavedChanges()` 而不是在这里再列一遍保存态：那个集合是「缓冲区里有磁盘上
 * 没有的东西」，与关标签页前要不要先落盘、改名要跳过哪些文档是同一条判据 —— 列两遍，
 * 将来加一个保存态就会漏掉一处。
 *
 * ## `+` 跟在最后一个标签之后，且不参与横向滚动
 *
 * 两个形态都要：标签少时它该紧跟在最后一个标签之后（浏览器 / Obsidian 的形态），
 * 标签多到装不下时它又不该被一起滚走。做到这点靠 `.nexus-tab-strip` 的 `flex: 0 1 auto`
 * —— 基准宽度取内容宽、只在装不下时才收缩。写成 `1 1 auto` 会让 strip 永远撑满整条栏，
 * `+` 就恒在最右端、离最后一个标签老远。
 *
 * `role="tablist"` 因此挂在 strip 上而不是整条栏上：`+` 不是 tab，混进列表里
 * 等于向读屏器谎报列表长度。零个文档时整条栏不渲染，这条判据在那时无从谈起。
 *
 * ## 标签被挤出去之后
 *
 * 溢出的一侧会**渐隐**（`data-overflow-*` 驱动 `.nexus-tab-strip` 的 mask），
 * 外加两条把标签够回来的路：
 *
 * - **纵向滚轮横滚**。没有它就没有任何鼠标路径 —— 滚动条是刻意藏掉的，而滚轮事件
 *   默认会冒泡去滚编辑器。到两端边界时**不拦截**，让那次滚轮落回编辑器，
 *   否则标签栏会变成滚轮的死区。
 * - **切标签时 `scrollIntoView`**。活动标签可能在视野外（键盘、命令面板、关掉旁边那个
 *   都会换活动标签），不滚进来的话用户不知道当前是哪一篇。
 *
 * 溢出状态是**量的**（`scrollWidth` vs `clientWidth`）而不是从标签数量推的：标签宽度由
 * 文件名长度和脏点决定，数不出来。重算挂在三处 —— `scroll`、`ResizeObserver`（窗口与侧栏
 * 改变宽度）、以及标签集合变化（strip 溢出后宽度被钉死，`ResizeObserver` 不会再响，
 * 光靠它会在「已经溢出时又多开一个标签」的情况下漏掉）。
 */
export const TabBar: React.FC<TabBarProps> = ({
  documents,
  activeId,
  onActivate,
  onClose,
  onCreate
}) => {
  const { t } = useLocale();
  const stripRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const hasDocuments = documents.length > 0;

  /**
   * 重算两端是否还有被遮住的标签。
   *
   * 留 1px 容差：分数像素缩放下滚到边界时 `scrollLeft` 常是 `299.5` 这种值，
   * 严格比较会让渐隐在最边缘处反复闪。
   */
  const syncOverflow = useCallback((): void => {
    const strip = stripRef.current;
    if (!strip) return;

    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft < maxScrollLeft - 1;

    // 没变就把原对象还回去 —— React 据此跳过渲染。否则滚动时每帧都要重渲染整条栏。
    setOverflow((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right }
    );
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(syncOverflow);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [hasDocuments, syncOverflow]);

  // 标签增删后单独重算一次：strip 一旦溢出，宽度就被「栏宽 − 按钮宽」钉死，
  // ResizeObserver 不会再响，而 scrollWidth 是变了的那一个。
  useEffect(() => {
    syncOverflow();
  }, [documents, hasDocuments, syncOverflow]);

  useEffect(() => {
    // `scrollIntoView` 在 happy-dom 里不存在，真机上才有；两个 `?.` 缺一不可
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    /**
     * 必须走**原生**监听：React 把 `onWheel` 注册成 passive，合成事件里调
     * `preventDefault()` 会被浏览器忽略（控制台还会报一句），结果是滚标签的同时编辑器也跟着滚。
     *
     * `deltaMode` 不分支：Electron 的滚轮恒是像素模式（0），行 / 页模式那两档是
     * 给 Firefox 之类留的，这里够不到。
     */
    const handleWheel = (event: WheelEvent): void => {
      // 横向手势（触摸板双指横扫）浏览器自己会滚，别抢
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return;

      const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
      if (maxScrollLeft <= 0) return;

      const next = Math.max(0, Math.min(maxScrollLeft, strip.scrollLeft + event.deltaY));
      // 到边界就不拦截：这次滚轮该落回编辑器，而不是在标签栏上卡住
      if (next === strip.scrollLeft) return;

      strip.scrollLeft = next;
      event.preventDefault();
    };

    strip.addEventListener('wheel', handleWheel, { passive: false });
    return () => strip.removeEventListener('wheel', handleWheel);
  }, [hasDocuments]);

  if (documents.length === 0) return null;

  return (
    <div className="nexus-tab-bar">
      <div
        ref={stripRef}
        className="nexus-tab-strip"
        role="tablist"
        data-overflow-left={overflow.left ? 'true' : 'false'}
        data-overflow-right={overflow.right ? 'true' : 'false'}
        onScroll={syncOverflow}
      >
        {documents.map((document) => {
          const name = document.filePath
            ? document.filePath.replace(/^.*[\\/]/, '')
            : t('tab.untitled');
          const isActive = document.id === activeId;
          const isUnsaved = hasUnsavedChanges(document);

          return (
            <div
              key={document.id}
              ref={isActive ? activeTabRef : undefined}
              role="tab"
              aria-selected={isActive}
              // 供 E2E 区分两类标签：DOM 上看不出「这条是只读的」，
              // 而「附件进的是同一份标签页集合」正是 P3-05 的核心不变量。
              data-document-kind={document.kind}
              className={`nexus-tab${isActive ? ' nexus-tab-active' : ''}`}
              title={document.filePath ?? name}
              onClick={() => onActivate(document.id)}
              // 鼠标中键关闭：浏览器与主流编辑器的通行行为
              onAuxClick={(event) => {
                if (event.button === 1) onClose(document.id);
              }}
            >
              {isUnsaved && <span className="nexus-tab-dot" aria-hidden="true" />}
              <span className="nexus-tab-name">{name}</span>
              <button
                type="button"
                className="nexus-tab-close"
                aria-label={t('tab.close', { name })}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(document.id);
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="nexus-tab-new"
        // 与工作区工具栏那枚「新建文件」是两回事（那个往磁盘上落一个新 .md），
        // 所以不共用 `new-file` 这个 action 名 —— E2E 的选择器必须能分开。
        data-action="new-document"
        title={t('cmd.newFile')}
        aria-label={t('cmd.newFile')}
        onClick={onCreate}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
};
