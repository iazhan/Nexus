/**
 * 快捷键分组。两段式，照抄「可重映射的动作表 + 只读的固定键清单」这个形态 —— 后者的价值
 * 就是**诚实**：只说「都能改」而实际有一批改不了，用户会在试了三次之后不再相信这一页。
 *
 * 为什么是专用组件而不是通用字段渲染器：这张表**不是一组字段**，是一张 n 行的表，每行有
 * 「当前组合键 / 捕获 / 取消绑定 / 恢复默认」四个动作，还带跨行冲突检测。塞进 `FieldDef`
 * 只会让那层多出一堆只服务这一个分组的字段（`kind: 'keybinding'`、`commandId`…）。
 *
 * 判据：捕获走 `window` 的**捕获阶段** + `stopPropagation()`。设置窗口的 Escape 关窗挂在
 * window 的冒泡阶段，捕获阶段先跑并掐断传播，所以「按 Escape 取消捕获」不会顺手把窗口关掉。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { formatShortcut, shortcutFromEvent } from '@nexus/command';
import { useKeybindingTable, useLocale } from '../hooks.js';
import {
  FIXED_SHORTCUTS,
  REMAPPABLE_ACTIONS,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride
} from '../keybindings.js';

/** 一次被拒的捕获：哪个动作、跟谁撞了。存 id 与 id 列表而不是译文，语言切换后不会留下旧文案。 */
interface ConflictNotice {
  actionId: string;
  withIds: string[];
}

const labelKeyOf = (id: string): string =>
  REMAPPABLE_ACTIONS.find((action) => action.id === id)?.labelKey ?? id;

export const KeybindingsSection: React.FC = () => {
  const { t } = useLocale();
  const keybindings = useKeybindingTable();
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConflictNotice | null>(null);

  const cancelCapture = useCallback(() => {
    setCapturingId(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    if (!capturingId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // 捕获阶段拦下一切：这一层在「按什么键」期间不能让别人也响应。
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        cancelCapture();
        return;
      }

      const spec = shortcutFromEvent(event);
      // 只按下修饰键时 `spec` 是 `null` —— 继续等真正的那个键，不是取消。
      if (!spec) return;

      const conflicts = keybindings.conflicts(spec, capturingId);
      if (conflicts.length > 0) {
        // **拒绝**而不是「接受 + 警告」：宿主的分发是「按注册顺序取第一个匹配」，接受冲突
        // 等于造出一条永远轮不到的绑定 —— 那比拒绝更难排查。
        setNotice({ actionId: capturingId, withIds: conflicts });
        setCapturingId(null);
        return;
      }

      setShortcutOverride(capturingId, spec);
      cancelCapture();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingId, cancelCapture, keybindings]);

  const anyOverridden = REMAPPABLE_ACTIONS.some((action) => keybindings.isOverridden(action.id));

  return (
    <section className="nexus-settings-section" data-section="keybindings">
      <h2 className="nexus-settings-section-title">{t('settings.section.keybindings')}</h2>

      <div className="nexus-settings-field">
        <div className="nexus-settings-field-head">
          <span className="nexus-settings-field-label">{t('settings.keybindings.remappable')}</span>
          {anyOverridden ? (
            <button
              type="button"
              className="nexus-settings-keybinding-resetall"
              data-keybinding-reset-all
              onClick={() => {
                resetAllShortcutOverrides();
                cancelCapture();
              }}
            >
              {t('settings.keybindings.resetAll')}
            </button>
          ) : null}
        </div>
        <p className="nexus-settings-field-description">
          {t('settings.keybindings.remappableDescription')}
        </p>

        {REMAPPABLE_ACTIONS.map((action) => {
          const spec = keybindings.resolve(action.id);
          const overridden = keybindings.isOverridden(action.id);
          const capturing = capturingId === action.id;
          const actionNotice = notice?.actionId === action.id ? notice : null;

          return (
            /* 冲突提示是「刚才那次捕获被拒了」，要立刻知道 —— `assertive` 而不是 `polite`。
               `aria-live` 挂在这一行的容器上（常驻），不是那行提示自己 —— 动态插入一个带
               `role="alert"` 的元素是不响的。 */
            <div
              className="nexus-settings-keybinding"
              key={action.id}
              data-keybinding={action.id}
              aria-live="assertive"
            >
              <span className="nexus-settings-keybinding-label">{t(action.labelKey)}</span>

              <button
                type="button"
                className={`nexus-settings-keybinding-capture${
                  capturing ? ' nexus-settings-keybinding-capture-active' : ''
                }`}
                data-keybinding-input={action.id}
                data-capturing={capturing ? 'true' : 'false'}
                aria-label={`${t(action.labelKey)} · ${t('settings.keybindings.capture')}`}
                onClick={() => {
                  setNotice(null);
                  setCapturingId(capturing ? null : action.id);
                }}
              >
                {capturing
                  ? t('settings.keybindings.capturing')
                  : spec
                    ? formatShortcut(spec)
                    : t('settings.keybindings.unbound')}
              </button>

              <button
                type="button"
                className="nexus-settings-keybinding-action"
                data-keybinding-clear={action.id}
                disabled={!spec || capturing}
                title={t('settings.keybindings.clear')}
                onClick={() => {
                  setShortcutOverride(action.id, null);
                  cancelCapture();
                }}
              >
                {t('settings.keybindings.clear')}
              </button>

              {overridden ? (
                <button
                  type="button"
                  className="nexus-settings-keybinding-action"
                  data-keybinding-reset={action.id}
                  title={t('settings.reset')}
                  onClick={() => {
                    resetShortcutOverride(action.id);
                    cancelCapture();
                  }}
                >
                  {t('settings.reset')}
                </button>
              ) : null}

              {actionNotice ? (
                <p className="nexus-settings-action-note" data-keybinding-conflict={action.id}>
                  {t('settings.keybindings.conflict', {
                    names: actionNotice.withIds.map((id) => t(labelKeyOf(id))).join('、')
                  })}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="nexus-settings-field">
        <div className="nexus-settings-field-head">
          <span className="nexus-settings-field-label">{t('settings.keybindings.fixed')}</span>
        </div>
        <p className="nexus-settings-field-description">
          {t('settings.keybindings.fixedDescription')}
        </p>
        <ul className="nexus-settings-keybinding-fixed-list">
          {FIXED_SHORTCUTS.map((entry) => (
            <li className="nexus-settings-keybinding-fixed" key={`${entry.spec}:${entry.labelKey}`}>
              <span className="nexus-settings-keybinding-fixed-label">{t(entry.labelKey)}</span>
              <span className="nexus-settings-keybinding-fixed-spec">
                {formatShortcut(entry.spec)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
