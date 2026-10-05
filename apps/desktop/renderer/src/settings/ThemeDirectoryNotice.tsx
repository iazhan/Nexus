import React, { useCallback, useSyncExternalStore } from 'react';
import type { BrokenThemeReason } from '../../../ipc/channels.js';
import { useLocale } from '../hooks.js';
import { subscribeThemeDirectory, themeDirectoryState } from '../theme-directory.js';

/**
 * 主题目录那一段：**路径 + 打开它的按钮 + 读不出来的文件清单**。
 *
 * 放在「导入 / 导出」旁边，因为它们是同一件事的两面 —— 都是「把外面的主题拿进来」，只是一个
 * 走界面、一个走文件系统。目录本身是**事实源**（Nexus 写出去的主题也在那儿），所以这一段
 * 不是可选的说明文字。
 *
 * ## 为什么坏文件必须画出来
 *
 * 目录里放了个手改坏的 YAML，静默跳过的话用户会以为「Nexus 不认我的文件」，而他会去怀疑
 * 主题格式、怀疑版本、怀疑自己 —— 唯独不会想到是那一个文件本身坏了。参考实现也把这类文件
 * 标成 warning 条目而不是丢掉，这是同一件事。
 *
 * **坏文件不进可选主题集合**：能被选中的主题必须全部通过了 16 槽校验。所以这里画的只是
 * 「哪些没进来、为什么」，不是一批「半可用」的选项。
 */

const REASON_KEYS: Record<BrokenThemeReason, string> = {
  unreadable: 'theme.directory.reason.unreadable',
  empty: 'theme.directory.reason.empty',
  'not-a-scheme': 'theme.directory.reason.notAScheme',
  'missing-slots': 'theme.directory.reason.missingSlots',
  'invalid-colour': 'theme.directory.reason.invalidColour',
  'duplicate-variant': 'theme.directory.reason.duplicateVariant'
};

export const ThemeDirectoryNotice: React.FC = () => {
  const { t } = useLocale();
  const subscribe = useCallback((listener: () => void) => subscribeThemeDirectory(listener), []);
  const state = useSyncExternalStore(subscribe, themeDirectoryState);

  const directory = window.nexus?.themeBoot?.directory ?? '';
  const openDirectory = (): void => {
    void window.nexus?.openThemeDirectory?.();
  };

  return (
    <div className="nexus-theme-directory" data-theme-directory="">
      <div className="nexus-theme-directory-head">
        <span className="nexus-theme-directory-title">{t('theme.directory.title')}</span>
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-directory-open=""
          onClick={openDirectory}
        >
          {t('theme.directory.open')}
        </button>
      </div>
      {directory !== '' && (
        <p className="nexus-settings-field-description" data-theme-directory-path>
          {t('theme.directory.description', { path: directory })}
        </p>
      )}

      {(state.broken.length > 0 || state.failed.length > 0) && (
        // `role="status"` 而不是 `alert`：它是启动时就摆在那里的既有状态，不是一次打断。
        <div className="nexus-theme-directory-warning" data-theme-directory-warning="" role="status">
          <span className="nexus-theme-directory-warning-title">
            {t('theme.directory.warning.title')}
          </span>
          <p className="nexus-settings-field-description">
            {t('theme.directory.warning.description')}
          </p>
          <ul className="nexus-theme-directory-warning-list">
            {state.broken.map((issue) => (
              <li key={`broken:${issue.fileName}`} data-theme-directory-broken={issue.fileName}>
                {t('theme.directory.brokenItem', {
                  file: issue.fileName,
                  reason: t(REASON_KEYS[issue.reason])
                })}
              </li>
            ))}
            {state.failed.map((fileName) => (
              <li key={`failed:${fileName}`} data-theme-directory-failed={fileName}>
                {t('theme.directory.failedItem', { file: fileName })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
