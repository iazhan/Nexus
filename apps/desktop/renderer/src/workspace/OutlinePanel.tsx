import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView, MarkdownDocumentSession } from '@nexus/editor';
import type { BacklinkEntry, UnlinkedMention } from '@nexus/core';
import { useLocale, useSettingValue } from '../hooks.js';
import { outlineLevelToMaxLevel } from '../settings/preference-specs.js';
import { extractOutline } from './outline.js';
import {
  buildOutlineRenderItems,
  resolveActiveHeadingOffset,
  visibleOutlineRenderItems
} from './outline-model.js';

export interface OutlinePanelProps {
  /** 当前活动文档的 session；大纲跟着它走 */
  session: MarkdownDocumentSession;
  /** 点击标题时跳转到源码偏移 */
  onJump: (offset: number) => void;
  /** 当前文档的绝对路径；反向链接按它查询。null 表示没有活动文档 */
  filePath: string | null;
  /** 点击反向链接时打开对应文档 */
  onOpenFile: (filePath: string) => void;
  /**
   * 当前编辑器视图。**可以缺省**（没有活动文档时），缺省就不做「当前在第几节」。
   *
   * 需要完整 `EditorView`（而不是 session 那个最小 seam）是因为要读滚动容器与几何：
   * 判断光标有没有滚出视口、以及视口中线落在文档的哪一行。
   */
  view?: EditorView | null;
  /** 光标偏移。它是「光标动了」的**变化信号**，值本身也从它来。 */
  cursorOffset?: number;
}

/**
 * 「当前在第几节」的参考位置。
 *
 * 口径是**光标优先 + 滚动兜底**：光标在视口内时它说了算（对得上「我在写哪一节」），
 * 光标滚出视口时改用视口中线（对得上「我在看哪一节」）。只用一种都会在另一半场景里出错 ——
 * 纯光标版在滚动浏览时高亮纹丝不动，纯滚动版在打字时高亮可能停在上一节。
 *
 * 视口中线走 `lineBlockAtHeight`（**文档坐标**，所以要把屏幕坐标减去 `documentTop`），
 * 不用 `coordsAtPos`：目标行常常不在 DOM 里（视口虚拟化），那时它直接返回 `null`。
 */
function referencePosition(view: EditorView, cursorOffset: number): number {
  const coords = view.coordsAtPos(cursorOffset);
  const scroller = view.scrollDOM.getBoundingClientRect();

  if (coords && coords.top >= scroller.top && coords.bottom <= scroller.bottom) {
    return cursorOffset;
  }

  return view.lineBlockAtHeight(scroller.top + scroller.height / 2 - view.documentTop).from;
}

/**
 * 折叠三角。展开朝下、折叠朝右，与参考实现一致 —— 朝右是「还有东西在里面」，
 * 朝下是「已经摊开了」。
 */
const OutlineChevron: React.FC<{ collapsed: boolean }> = ({ collapsed }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
  </svg>
);

/**
 * 文档大纲面板。
 *
 * 数据来自**当前编辑器的源码**，不是索引 —— 大纲要反映「正在写的这份文本」，
 * 而索引是磁盘状态、天然滞后。所以这里直接订阅 session。
 *
 * 自己订阅而不是让 App 传 `source`：App 的 `session` 是个可变对象，
 * `getSnapshot()` 不触发重渲染，要么在 App 里再加一个「内容版本号」state，
 * 要么就在这里订阅。后者内聚得多，也不用让 App 多背一个状态。
 */
export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  session,
  onJump,
  filePath,
  onOpenFile,
  view = null,
  cursorOffset = 0
}) => {
  const { t } = useLocale();
  const [source, setSource] = useState(() => session.getSnapshot().source);
  const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
  const [mentions, setMentions] = useState<UnlinkedMention[]>([]);
  const [mentionsTruncated, setMentionsTruncated] = useState(false);

  useEffect(() => {
    // 换文档（切标签页）时先同步一次，再订阅后续变更
    setSource(session.getSnapshot().source);
    return session.subscribe((snapshot) => {
      setSource(snapshot.source);
    });
  }, [session]);

  // 反向链接只在**换文档**时重查。
  // 编辑当前文档不会改变「谁链接到我」—— 那是别的文档的内容决定的，
  // 而当前文档自身的出链变化由索引器负责，不在这里反映。
  useEffect(() => {
    if (!filePath) {
      setBacklinks([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.findBacklinks?.(filePath)) ?? [];
        if (!cancelled) setBacklinks(list);
      } catch (err) {
        console.error('Failed to load backlinks:', err);
        if (!cancelled) setBacklinks([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  /*
    未链接提及：哪些文档在正文里提到了这一篇，却没有写成链接。

    与反向链接**同一次查询时机**（换文档时才查）：两者都由「别的文档写了什么」决定，
    而编辑当前文档不会改变它。区别是这一次要扫全库正文，所以主进程那边有大小与条数两道闸。
  */
  useEffect(() => {
    if (!filePath) {
      setMentions([]);
      setMentionsTruncated(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const result = (await window.nexus?.findMentions?.(filePath)) ?? {
          mentions: [],
          truncated: false
        };
        if (cancelled) return;
        setMentions(result.mentions);
        setMentionsTruncated(result.truncated);
      } catch (err) {
        console.error('Failed to load mentions:', err);
        if (!cancelled) {
          setMentions([]);
          setMentionsTruncated(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const headings = useMemo(() => extractOutline(source), [source]);

  // 「大纲显示到第几级」是设置项，不是这里的 state —— 见 `registry.ts` 的字段说明。
  const outlineLevel = useSettingValue('editor.outlineLevel');
  const renderItems = useMemo(
    () => buildOutlineRenderItems(headings, outlineLevelToMaxLevel(outlineLevel)),
    [headings, outlineLevel]
  );

  const [reference, setReference] = useState<number | null>(null);

  // 滚动：光标没动，但视口动了 ——「光标还在不在视口里」的答案可能变了。
  // rAF 节流是必需的：滚动事件一秒能来上百次，每次都 setState 会把 React 打爆。
  useEffect(() => {
    if (!view) return;

    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setReference(referencePosition(view, view.state.selection.main.head));
      });
    };

    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [view]);

  // 光标或视图变了：立刻算，不等下一帧 —— 高亮是这次渲染的一部分。
  // 这里用 prop 而不是 `view.state`：prop 才是「变了」的那个信号，两者指向同一个位置。
  //
  // 没有 view 时退化成「只看光标」：判不了「光标在不在视口里」，就不判 ——
  // 这比不高亮好，没有活动文档的启动瞬间也能指对地方。
  useEffect(() => {
    setReference(view ? referencePosition(view, cursorOffset) : cursorOffset);
  }, [view, cursorOffset]);

  const activeOffset = useMemo(
    () => (reference === null ? null : resolveActiveHeadingOffset(headings, reference)),
    [headings, reference]
  );

  const listRef = useRef<HTMLUListElement | null>(null);

  /**
   * 把高亮项滚进**大纲面板自己的**视口。
   *
   * 手算 `scrollTop` 而不用 `scrollIntoView`：后者会滚动**所有**可滚祖先，而这个界面里
   * 编辑器、侧栏、面板各有各的滚动容器 —— 连带滚一个，用户看到的就是「点一下大纲，
   * 编辑器跟着跳」。（`overflow: hidden` 的祖先照样能被 `scrollIntoView` 滚，别指望它挡住。）
   *
   * 只在 `activeOffset` 变化时跑：用户自己翻大纲时它没变，所以不会被拽回去；
   * 反过来高亮项被光标或滚动带出面板时，这里会把它带回来。
   */
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !active) return;

    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    if (activeRect.top < listRect.top) {
      list.scrollTop -= listRect.top - activeRect.top;
    } else if (activeRect.bottom > listRect.bottom) {
      list.scrollTop += activeRect.bottom - listRect.bottom;
    }
  }, [activeOffset]);

  /**
   * 折叠状态**不随文档切换重置**：用户折起「常见问题」再切走切回来，期待它还是折着的。
   * 键里没有下标（见 `outline-model.ts` 文件头），所以编辑当前文档不会让它错位。
   */
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const visibleItems = useMemo(
    () => visibleOutlineRenderItems(renderItems, collapsedKeys),
    [renderItems, collapsedKeys]
  );

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  /**
   * 空态那个「添加标题」按钮。
   *
   * **插在文首**：文档没有标题时，标题本来就该在最上面；插在光标处的话落点取决于光标在哪，
   * 而用户按这个按钮的意思就是「我要有个标题结构」。
   *
   * **光标落在 `# ` 后面**（偏移 2），用户可以直接接着打字。不设选区的话光标会留在原处，
   * 表现就是「点了按钮，看起来什么都没发生」。
   *
   * 与跳转相反，这是一次**真编辑** —— 该进撤销历史，Ctrl+Z 要能撤掉它。
   */
  const insertHeading = useCallback(() => {
    session.dispatch({
      changes: [{ from: 0, to: 0, insert: '# ' }],
      selection: { anchor: 2, head: 2 }
    });
  }, [session]);

  return (
    <div className="nexus-outline">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.outline')}</span>
        {headings.length > 0 && (
          <span className="nexus-sidebar-count">{headings.length}</span>
        )}
      </div>

      {headings.length === 0 ? (
        // 空态不只是「没有东西」，还要给一条出路 —— 否则用户得自己想到「先打个 #」。
        <div className="nexus-sidebar-note">
          <p>{t('outline.empty')}</p>
          <button type="button" className="nexus-outline-insert" onClick={insertHeading}>
            {t('outline.insertHeading')}
          </button>
        </div>
      ) : (
        <ul className="nexus-sidebar-list" ref={listRef}>
          {visibleItems.map(({ heading, key, hasChildren }) => {
            const collapsed = collapsedKeys.has(key);
            // 当前所处的这一节。被折叠藏起来的项匹配不上也没关系 ——
            // 用户自己折的，它本来就不在列表里。
            const active = activeOffset !== null && heading.offset === activeOffset;

            return (
              <li key={key}>
                <div className={`nexus-outline-row nexus-outline-level-${heading.level}`}>
                  {hasChildren ? (
                    <button
                      type="button"
                      className="nexus-outline-toggle"
                      data-collapsed={collapsed ? 'true' : 'false'}
                      aria-expanded={!collapsed}
                      aria-label={`${
                        collapsed ? t('outline.expand') : t('outline.collapse')
                      }: ${heading.text}`}
                      // 别让折叠按钮抢走焦点：抢了之后编辑器失焦，接着打字打不进去。
                      // `preventDefault` 拦在 mousedown 上才有效，`onClick` 里已经晚了。
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggleCollapsed(key)}
                    >
                      <OutlineChevron collapsed={collapsed} />
                    </button>
                  ) : (
                    // 占位：没有子项的标题也要和同级标题左对齐
                    <span className="nexus-outline-toggle" aria-hidden="true" />
                  )}

                  <button
                    type="button"
                    className="nexus-outline-item"
                    data-active={active ? 'true' : undefined}
                    // 读屏用的也是同一个事实，别只写个 class 了事
                    aria-current={active ? 'location' : undefined}
                    title={heading.text}
                    onClick={() => onJump(heading.offset)}
                  >
                    {heading.text}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 反向链接放在大纲下面：两者都是「当前文档的视图」，
          合成一个面板比再加一个活动栏图标更省事，也更贴近使用习惯。 */}
      {filePath && (
        <div className="nexus-backlinks">
          <div className="nexus-sidebar-header">
            <span className="nexus-sidebar-root">{t('backlinks.title')}</span>
            {backlinks.length > 0 && (
              <span className="nexus-sidebar-count">{backlinks.length}</span>
            )}
          </div>

          {backlinks.length === 0 ? (
            <p className="nexus-sidebar-note">{t('backlinks.empty')}</p>
          ) : (
            <ul className="nexus-sidebar-list">
              {backlinks.map(({ document, anchor }) => (
                <li key={document.id}>
                  <button
                    type="button"
                    className="nexus-backlink-item"
                    title={anchor === null ? document.path : `${document.path} › ${anchor}`}
                    onClick={() => onOpenFile(document.path)}
                  >
                    {document.relativePath}
                    {/*
                      锚点只是「引的是哪一节」的提示，不参与跳转 —— 打开文档这件事
                      在编辑器侧还没接上「滚到某个标题」。所以它是纯文本而不是按钮。
                    */}
                    {anchor !== null && (
                      <span className="nexus-backlink-anchor">{anchor}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/*
        未链接提及。与反向链接分开两节（而不是混进同一个列表）：它们的**动作**不同 ——
        反向链接是「已经连上了，去看看」，提及是「还没连上，去补一条」。混在一起的话，
        用户分不清哪一条点了会跳走、哪一条点了要自己动手。
      */}
      {filePath !== null && (
        <div className="nexus-mentions">
          <div className="nexus-sidebar-header">
            <span className="nexus-sidebar-root">{t('mentions.title')}</span>
            {mentions.length > 0 && (
              <span className="nexus-sidebar-count">{mentions.length}</span>
            )}
          </div>

          {mentions.length === 0 ? (
            <p className="nexus-sidebar-note">{t('mentions.empty')}</p>
          ) : (
            <>
              <ul className="nexus-sidebar-list">
                {mentions.map((mention) => (
                  <li key={`${mention.document.id}:${mention.from}`}>
                    <button
                      type="button"
                      className="nexus-mention-item"
                      title={mention.document.path}
                      onClick={() => onOpenFile(mention.document.path)}
                    >
                      <span className="nexus-mention-source">{mention.document.relativePath}</span>
                      {/* 摘录让用户不必打开就能判断「这处提的是不是这一篇」 */}
                      <span className="nexus-mention-excerpt">{mention.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {mentionsTruncated && (
                // 截断了就说出来 —— 静默少几条会让用户以为「就这么多」
                <p className="nexus-sidebar-note nexus-mention-truncated">
                  {t('mentions.truncated', { count: String(mentions.length) })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
