import React, { useMemo } from 'react';
import type { ExtensionHost } from '@nexus/editor';
import { useLocale } from '../hooks.js';

export interface PluginsPanelProps {
  /** 扩展宿主；App 在挂载时就建好了，所以正常不会 undefined */
  host: ExtensionHost | undefined;
  /**
   * 重读状态的触发信号。
   *
   * `ExtensionHost` 本身没有变更通知（它是个纯注册表），所以这里借 App 的
   * 「文档内容版本号」当刷新信号：编辑或切换文档时会重新读一次状态。
   * 代价是扩展「加载完成」的那一瞬间面板可能还显示「加载中」——
   * 下一次编辑就会刷过来。要做到实时得给 host 加订阅，那是另一件事。
   */
  revision: number;
}

/**
 * 插件面板：列出已注册的扩展及其状态。
 *
 * 显示的重点是 `idle`（已注册但文档里从没出现过触发语法、扩展包一个字节都没下载）
 * 与 `loaded` 的对比 —— 这是「按内容懒加载」最直观的证据。
 */
export const PluginsPanel: React.FC<PluginsPanelProps> = ({ host, revision }) => {
  const { t } = useLocale();

  const extensions = useMemo(
    () => host?.listExtensions() ?? [],
    // revision 是刻意的依赖：它变化时重读 host 的状态
    [host, revision]
  );

  return (
    <div className="nexus-plugins">
      <div className="nexus-sidebar-header">
        <span className="nexus-sidebar-root">{t('activity.extensions')}</span>
        {extensions.length > 0 && (
          <span className="nexus-sidebar-count">{extensions.length}</span>
        )}
      </div>

      {extensions.length === 0 ? (
        <p className="nexus-sidebar-note">{t('plugins.empty')}</p>
      ) : (
        <ul className="nexus-sidebar-list">
          {extensions.map((extension) => (
            <li key={extension.id}>
              <div className="nexus-plugin-row" title={extension.id}>
                <span className="nexus-plugin-name">{extension.id}</span>
                <span className={`nexus-plugin-state nexus-plugin-state-${extension.state}`}>
                  {t(`plugins.state.${extension.state}`)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="nexus-sidebar-note">{t('plugins.hint')}</p>
    </div>
  );
};
