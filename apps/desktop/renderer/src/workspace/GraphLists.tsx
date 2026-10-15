import React, { useEffect, useRef, useState } from 'react';
import type { HubEntry, IndexedDocument, OrphanMode } from '@nexus/core';
import { ORPHAN_MODES } from '@nexus/core';
import { useLocale } from '../hooks.js';
import { requireGraphBridge, type GraphPhase } from './graph-load.js';

/**
 * 图谱的**两个列表视图**：孤儿与枢纽。
 *
 * ## 为什么它们不在画布上做
 *
 * 这两个问题的答案是一张**清单**，不是一张图。孤儿是「写了就忘的文档」，枢纽是
 * 「被引用最多的文档」—— 用户要的是一篇篇点开处理，而不是在几百个点里用眼睛找。
 * 画布那边已经能看出形状了，这里补的是「可枚举、可点击」。
 *
 * ## 各自取自己的数据
 *
 * 没有让 `GraphPanel` 取好再传进来：那两个查询与画布的查询**互不相关**，
 * 混在一个 effect 里会让「切视图」也要重取画布的图。三个视图各自订阅 `revision`，
 * 谁需要谁取。
 *
 * ## 空态分三档
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
