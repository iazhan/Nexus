import React, { useEffect, useRef, useState } from 'react';
import type { DeadLinkEntry, HubEntry, IndexedDocument, OrphanMode } from '@nexus/core';
import { ORPHAN_MODES } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { requireGraphBridge, type GraphPhase } from './graph-load.js';

/**
 * 图谱的**三个列表视图**：孤儿、枢纽、断链。
 *
 * ## 为什么它们不在画布上做
 *
 * 这三个问题的答案都是一张**清单**，不是一张图。孤儿是「写了就忘的文档」，枢纽是
 * 「被引用最多的文档」，断链是「写了但还没建的目标」—— 用户要的是一篇篇点开处理，
 * 而不是在几百个点里用眼睛找。画布那边已经能看出形状了，这里补的是「可枚举、可点击」。
 *
 * ## 各自取自己的数据
 *
 * 没有让 `GraphPanel` 取好再传进来：这三个查询与画布的查询**互不相关**，
 * 混在一个 effect 里会让「切视图」也要重取画布的图。三个视图各自订阅 `revision`，
 * 谁需要谁取。
 *
 * ## 空态分档
 *
 * 孤儿有三种模式，每种「空」的含义不同（没人引用 / 不引用别人 / 两者都缺）。
 * 共用一句话的话，用户看到的会是「没有孤儿」，而他明明刚筛掉了另一类 ——
 * 与文件树「因过滤才变空的目录要丢弃」是同一条判据：**空的原因要说清楚**。
 *
 * ## 四态：错误 → 加载中 → 空 → 列表
 *
 * 顺序固定、互斥（语义见 `graph-load.ts`）。两条容易写错的：
 *
 * - **失败不能渲染成空态。** 原来是 `catch → console.error → 置空`，于是「取数挂了」
 *   和「一条孤儿都没有」在屏幕上完全一样。
 * - **换模式要回到加载中，只换 `revision` 不用。** 换模式等于换了一个问题，
 *   旧答案对新问题不成立；而 `revision` 变化是同一个问题重取一次，保留旧清单才不会闪。
 */
export interface GraphListsProps {
  /** 索引变化信号；变化时重取 */
  revision: number;
  onOpenFile: (filePath: string) => void;
}

const ORPHANS_LIMIT_HINT = 200;

export const OrphansList: React.FC<GraphListsProps> = ({ revision, onOpenFile }) => {
  const { t } = useLocale();
  const [mode, setMode] = useState<OrphanMode>('both');
  const [orphans, setOrphans] = useState<IndexedDocument[]>([]);
  const [phase, setPhase] = useState<GraphPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const previousModeRef = useRef<OrphanMode | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (previousModeRef.current !== mode) setPhase('loading');
    previousModeRef.current = mode;

    void (async () => {
      try {
        const list = await requireGraphBridge().getGraphOrphans(mode);
        if (cancelled) return;
        setOrphans(list);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        console.error('Failed to load orphans:', err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision, mode]);

  return (
    <div className="nexus-graph-list" data-phase={phase}>
      <div className="nexus-graph-list-modes" role="group" aria-label={t('graph.orphans.mode')}>
        {ORPHAN_MODES.map((value) => (
          <button
            key={value}
            type="button"
            className="nexus-graph-chip"
            data-orphan-mode={value}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {t(`graph.orphans.mode.${value}`)}
          </button>
        ))}
      </div>

      {phase === 'error' ? (
        <p className="nexus-graph-note nexus-sidebar-error" data-error={loadError ?? ''}>
          {t('graph.loadFailed')}
        </p>
      ) : phase === 'loading' ? (
        <p className="nexus-sidebar-note">{t('graph.loading')}</p>
      ) : orphans.length === 0 ? (
        <p className="nexus-sidebar-note">{t(`graph.orphans.empty.${mode}`)}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {orphans.slice(0, ORPHANS_LIMIT_HINT).map((document) => (
            <li key={document.id}>
              <button
                type="button"
                className="nexus-backlink-item"
                title={document.path}
                onClick={() => onOpenFile(document.path)}
              >
                {document.relativePath}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** 列表里最多画多少条。比 `getHubs` 的默认上限大得多 —— 这里是「看全」而不是「看头几名」。 */
const HUBS_LIMIT = 100;

export const HubsList: React.FC<GraphListsProps> = ({ revision, onOpenFile }) => {
  const { t } = useLocale();
  const [hubs, setHubs] = useState<HubEntry[]>([]);
  const [phase, setPhase] = useState<GraphPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await requireGraphBridge().getGraphHubs(HUBS_LIMIT);
        if (cancelled) return;
        setHubs(list);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        console.error('Failed to load hubs:', err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return (
    <div className="nexus-graph-list" data-phase={phase}>
      {phase === 'error' ? (
        <p className="nexus-graph-note nexus-sidebar-error" data-error={loadError ?? ''}>
          {t('graph.loadFailed')}
        </p>
      ) : phase === 'loading' ? (
        <p className="nexus-sidebar-note">{t('graph.loading')}</p>
      ) : hubs.length === 0 ? (
        <p className="nexus-sidebar-note">{t('graph.hubs.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {hubs.map((entry) => (
            <li key={entry.document.id}>
              <button
                type="button"
                className="nexus-backlink-item"
                title={entry.document.path}
                onClick={() => onOpenFile(entry.document.path)}
              >
                {entry.document.relativePath}
                {/* 计数是这一屏的全部信息 —— 没有它，这个列表和文件树没区别 */}
                <span className="nexus-graph-list-count">
                  {t('graph.hubs.incoming', { count: String(entry.count) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * 断链清单：写了链接、但**整个工作区**里都没有对应文档的目标。
 *
 * ## 画布上已经有红点了，为什么还要这一屏
 *
 * 红点告诉你「这里有东西缺着」，但不告诉你「一共缺几个、哪个最该先建」。这两件事
 * 只有清单答得了 —— 而且断链是唯一一类「点开它没有文档可看」的东西，画布上它
 * 只是一堆空心圈，连名字都挤不下。
 *
 * ## 一行 = 一个**目标**，不是一对「目标 + 来源」
 *
 * 用户要处理的对象是目标（要么建它，要么把引用它的写法改掉）。按对拆行的话，
 * 「`dma` 被 3 篇引用」会变成三行一模一样的 `dma`，而「最该先建哪个」这件事
 * 反而看不出来了。来源挂在目标下面，可点开去看那篇是怎么写的。
 *
 * ## 顺序是主进程给的，这里不重排
 *
 * 来源数降序、同数按目标名 —— 全序由 `IndexStore.getDeadLinks()` 保证。在渲染层
 * 再排一次等于把「顺序的口径」抄成两份，迟早不一致。
 */
export const DeadLinksList: React.FC<GraphListsProps> = ({ revision, onOpenFile }) => {
  const { t } = useLocale();
  const [entries, setEntries] = useState<DeadLinkEntry[]>([]);
  const [phase, setPhase] = useState<GraphPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await requireGraphBridge().getGraphDeadLinks();
        if (cancelled) return;
        setEntries(list);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        console.error('Failed to load dead links:', err);
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return (
    <div className="nexus-graph-list" data-phase={phase}>
      {phase === 'error' ? (
        <p className="nexus-graph-note nexus-sidebar-error" data-error={loadError ?? ''}>
          {t('graph.loadFailed')}
        </p>
      ) : phase === 'loading' ? (
        <p className="nexus-sidebar-note">{t('graph.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="nexus-sidebar-note">{t('graph.dead.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {entries.map((entry) => (
            <li key={entry.target} data-dead-link={entry.target}>
              {/* 目标名是**主文案**：要建的就是它，而它自己点不出任何文档 */}
              <div className="nexus-graph-dead-target">
                {entry.target}
                <span className="nexus-graph-list-count">
                  {t('graph.dead.count', { count: String(entry.count) })}
                </span>
              </div>
              <ul className="nexus-graph-dead-sources" aria-label={t('graph.dead.sources')}>
                {entry.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      type="button"
                      className="nexus-backlink-item"
                      title={source.path}
                      onClick={() => onOpenFile(source.path)}
                    >
                      {source.relativePath}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
