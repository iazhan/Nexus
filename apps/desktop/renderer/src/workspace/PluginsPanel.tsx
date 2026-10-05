import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ExtensionHost } from '@nexus/editor';
import type { ViewerRendererRegistry } from '../viewer/registry.js';
import { buildCapabilityManifest } from './capability-manifest.js';
import { useLocale } from '../hooks.js';

export interface PluginsPanelProps {
  /** 扩展宿主；App 在挂载时就建好了，所以正常不会 undefined */
  host: ExtensionHost | undefined;
  /** 附件渲染器登记表；同上 */
  viewers: ViewerRendererRegistry | undefined;
  /**
   * 打开设置窗口的「插件」页。**这是本面板唯一的写入口** ——
   * 它自己一个字节都不落盘，管理动作全在设置页（决策 #2：这个面板是只读状态视图）。
   */
  onManage?: () => void;
}

/**
 * 插件面板：列出 Nexus 的**全部内置能力**及其状态。
 *
 * 内容来自 `buildCapabilityManifest()`（两个注册表的只读投影），面板只负责画，
 * 不负责判定「有哪些能力」—— 那份判定只有注册表有，这里复制一份就会漂移。
 *
 * 显示的重点是 `idle`（已登记但文档里从没出现过触发语法、也没打开过该类型附件，
 * 包一个字节都没下载）与 `loaded` 的对比 —— 这是「按内容懒加载」最直观的证据。
 *
 * **状态是订阅来的，不是拉来的。** 两个注册表都在用户看不见的时候改状态（投影挂载、
 * 打开附件），只靠 props 变化重读的话，面板会停在「加载中」直到下一次别的原因触发重渲染 ——
 * 而「刚打开一个 PDF，面板立刻显示已加载」正是这个面板要证明的事。订阅走
 * `useSyncExternalStore`：通知发生在 React 之外，它保证重渲染读到的已是提交后的值。
 */
export const PluginsPanel: React.FC<PluginsPanelProps> = ({ host, viewers, onManage }) => {
  const { t } = useLocale();

  // 订阅函数的身份必须稳定：它进 `useSyncExternalStore` 的依赖，每次渲染换一个新函数
  // 会导致「退订 + 重新订阅」反复发生 —— 恰好落在那一瞬间的通知会被漏掉。
  // 两个注册表各自订阅、逐个退订；缺一个就少一半状态来源。
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes: Array<() => void> = [];
      if (host) unsubscribes.push(host.subscribe(listener));
      if (viewers) unsubscribes.push(viewers.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [host, viewers]
  );

  // 快照必须是**基本类型**：每次读都返回新数组会让 `useSyncExternalStore` 认为「一直在变」，
  // 从而无限重渲染。两个计数器只增不减，所以和也单调 —— 任一注册表跃迁都会让它变化。
  const revision = useSyncExternalStore(
    subscribe,
    useCallback(() => (host?.revision ?? 0) + (viewers?.revision ?? 0), [host, viewers])
  );

  const entries = useMemo(
    // 这里**不读 `revision`**，它只是触发器：注册表的状态不是 React state，没有它
    // 这份清单不会重算 —— 面板就会停在旧状态，正是这次要修的那个 bug。
    () => buildCapabilityManifest(host, viewers),
    [host, viewers, revision]
  );

  return (
    <div className="nexus-plugins">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.extensions')}</span>
        {entries.length > 0 && (
          <span className="nexus-sidebar-count">{entries.length}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="nexus-sidebar-note">{t('plugins.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {entries.map((entry) => (
            // 两种来源的 id 各自唯一，但拼上前缀更稳：将来加一类来源时不会撞 key
            <li key={`${entry.kind}:${entry.id}`}>
              {/* 裸 id 留在 `title` 上：可读名是给人看的，id 是排查问题时要对的那个。
                  状态另有 `data-plugin-status`，测试据此断言，不靠类名拼接猜。 */}
              <div
                className="nexus-plugin-row"
                title={entry.id}
                data-plugin-id={entry.id}
                data-plugin-kind={entry.kind}
                data-plugin-status={entry.status}
                data-plugin-source={entry.source}
              >
                <span className="nexus-plugin-name">{t(entry.labelKey)}</span>
                {/* 来源标记**只在不是内置时画**（P2-6）。今天全是内置 ⇒ 一枚都不出现；
                    给每一行挂一枚「内置」是纯噪声，还会把「这一条不一样」这个信号稀释掉。
                    等真有第三方能力时标记自动出现，不必再改 UI。 */}
                {entry.source !== 'builtin' && (
                  <span className="nexus-plugin-source">{t('plugins.source.community')}</span>
                )}
                <span className={`nexus-plugin-state nexus-plugin-state-${entry.status}`}>
                  {t(`plugins.state.${entry.status}`)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="nexus-sidebar-note">{t('plugins.hint')}</p>

      {/* 跳转按钮走 `data-action`：与面板里其它可点元素一样按属性断言，不靠文案。
          只在宿主给了回调时画 —— 没给就是「这里没有可去的地方」，画一个点了没反应的按钮更糟。 */}
      {onManage && (
        <button
          type="button"
          className="nexus-sidebar-action nexus-plugin-manage"
          data-action="manage-plugins"
          onClick={onManage}
        >
          {t('plugins.manage')}
        </button>
      )}
    </div>
  );
};
