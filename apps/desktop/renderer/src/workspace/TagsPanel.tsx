import React, { useEffect, useRef, useState } from 'react';
import type { IndexedDocument } from '@nexus/core';
import { useLocale } from '../hooks.js';

export interface TagsPanelProps {
  /**
   * 打开文档，并把**被点击的那个标签**滚到视口第一行。
   *
   * 第二个参数是被点的标签，而不是「文档里的某个标签」—— 一篇文档可以带多个标签，
   * 用户点的是哪一行，就该定位到哪一个。
   */
  onOpenDocument: (filePath: string, tag: string) => void;
  /** 索引变化信号；变化时重读标签列表 */
  revision: number;
  /**
   * 外部要求展开的标签（编辑器里 Ctrl+点击标签）。
   *
   * 带 `seq` 而不是裸字符串：连着点同一个标签两次，两次都要各展开一次 ——
   * 裸字符串两次是同一个值，effect 的依赖比较看不出区别。
   */
  focusTag?: { tag: string; seq: number } | null;
}

/**
 * 标签面板。
 *
 * 列出所有标签及文档数，点开某个标签才去查它的文档 ——
 * 一次性把所有标签的文档都拉回来，在标签多、文档多的工作区里是纯浪费。
 */
export const TagsPanel: React.FC<TagsPanelProps> = ({ onOpenDocument, revision, focusTag }) => {
  const { t } = useLocale();
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const listRef = useRef<HTMLUListElement | null>(null);

  // 外部要求展开的标签直接接管展开态。标签可能还没进索引（刚写下、索引还没跑完），
  // 那种情况下展开的是一张空列表 —— 比「点了没反应」诚实。
  useEffect(() => {
    if (focusTag) setExpandedTag(focusTag.tag);
  }, [focusTag]);

  /**
   * 把外部要求展开的标签滚进**标签面板自己的**视口。
   *
   * 手算 `scrollTop` 而不用 `scrollIntoView`：后者会滚动**所有**可滚祖先 ——
   * 这个界面里编辑器、侧栏、面板各有各的滚动容器，连带滚一个，用户看到的就是
   * 「点一下标签，编辑器跟着跳」。（`overflow: hidden` 的祖先照样能被它滚，别指望它挡住。）
   *
   * 依赖里必须有 `tags.length`：`listTags()` 是异步的，首次进来时列表还是空的 ——
   * 那一趟找不到目标项。标签到位后必须重跑一次，否则这次滚动就丢了。
   *
   * 也必须有 `expandedTag`：展开会把文档列表插进 DOM，标签项的位置随之改变
   * （展开的是列表靠前的项时，它会被往下推），只看 `focusTag` 量到的是展开**之前**的几何。
   * 而 `expandedTag === focusTag.tag` 这个等号又挡住了「用户手动展开别的标签」——
   * 那种情况不该把视口拽回 focusTag 那一项。
   *
   * 不在视口里才动：已经在视口里时一个像素都不改，否则用户每次点标签都会被拽一下。
   */
  useEffect(() => {
    if (!focusTag || expandedTag !== focusTag.tag) return;

    const list = listRef.current;
    if (!list) return;
    // 按 dataset 比对而不是拼属性选择器：标签名可以带 `/`、中文，拼进去要转义。
    const item = Array.from(list.querySelectorAll<HTMLElement>('[data-tag]')).find(
      (element) => element.dataset.tag === focusTag.tag
    );
    if (!item) return;

    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();

    if (itemRect.top < listRect.top) {
      list.scrollTop -= listRect.top - itemRect.top;
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.bottom - listRect.bottom;
    }
  }, [focusTag, expandedTag, tags.length]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.listTags?.()) ?? [];
        if (!cancelled) setTags(list);
      } catch (err) {
        console.error('Failed to load tags:', err);
        if (!cancelled) setTags([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    if (!expandedTag) {
      setDocuments([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const list = (await window.nexus?.findDocumentsByTag?.(expandedTag)) ?? [];
        if (!cancelled) setDocuments(list);
      } catch (err) {
        console.error('Failed to load documents for tag:', err);
        if (!cancelled) setDocuments([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expandedTag, revision]);

  return (
    <div className="nexus-tags">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.tags')}</span>
        {tags.length > 0 && <span className="nexus-sidebar-count">{tags.length}</span>}
      </div>

      {/* 空态也渲染这个 `<ul>`：它是滚动容器，而下面的滚动 effect 要 `listRef` 有值。
          让它随内容出现/消失的话，`tags` 异步到位之前 ref 一直是 null，那次滚动就丢了
          —— effect 的依赖里没有 `tags`，不会补跑。 */}
      <ul className="nexus-sidebar-list" ref={listRef}>
        {tags.length === 0 ? (
          <li className="nexus-sidebar-note">{t('tags.empty')}</li>
        ) : (
          tags.map(({ tag, count }) => {
            const isExpanded = expandedTag === tag;
            return (
              <li key={tag}>
                <button
                  type="button"
                  className={`nexus-tag-item${isExpanded ? ' nexus-tag-item-active' : ''}`}
                  data-tag={tag}
                  aria-expanded={isExpanded}
                  title={`#${tag}`}
                  onClick={() => setExpandedTag((previous) => (previous === tag ? null : tag))}
                >
                  <span className="nexus-tag-name">#{tag}</span>
                  <span className="nexus-tag-count">{count}</span>
                </button>

                {isExpanded && (
                  <ul className="nexus-tag-documents">
                    {documents.map((document) => (
                      <li key={document.id}>
                        <button
                          type="button"
                          className="nexus-backlink-item"
                          title={document.path}
                          onClick={() => onOpenDocument(document.path, tag)}
                        >
                          {document.relativePath}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
};
