/**
 * 通用字段渲染器：按 `FieldDef.control` 画一行设置（标签 + 说明 + 控件 + 重置键）。
 *
 * **为什么要有它**：`AppearanceSection` 是手写的专用组件 —— 主题卡片网格不是通用控件能表达的。
 * 但 `general` / `editor` / `files` 里全是普通控件，每个分组再手写一遍「标签 + 说明 + 控件」，
 * 等于把字段表的信息抄第二遍，而抄一遍必然漂移（菜单与设置页漂移过一次，注册表就是为此建的）。
 *
 * 值的读写全走 `accessor` 的三个动作，渲染器**不知道**值存在 store、`localeManager` 还是别处 ——
 * 这是「字段表是唯一数据源」能覆盖 `locale` / mermaid 那两个未迁移项的原因。
 *
 * 控件覆盖 `radio / select / toggle / number / text`。`preset` 与 `action` **不在这里**：
 * 前者是主题卡片网格（专用组件），后者是一组动作按钮，两者都还没有通用形状。
 *
 * 重置键的显隐判据是 `resetValue` 且**当前值不等于它** —— 见 `FieldDef.resetValue` 的注释。
 */

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocale } from '../hooks.js';
import { optionLabel, optionsOf, type FieldDef } from './registry.js';

type Translate = (key: string, vars?: Record<string, string>) => string;

/** 逆时针箭头。与主题卡片上的「复制」不同：它不造东西，只是把这一项退回默认值。 */
const ResetIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

/**
 * 订阅一个字段的值。
 *
 * 不能用 `useSettingValue(path)` —— 那只认 `SettingsStore` 的 path，而 `locale` 与 mermaid
 * 偏好的值是各自管理器持有的。`accessor.read()` 返回字符串，所以快照天然稳定，
 * `useSyncExternalStore` 不会因为「每次读都造新对象」而无限重渲染。
 */
function useFieldValue(field: FieldDef): string {
  const subscribe = useCallback(
    (listener: () => void) => field.accessor.subscribe(listener),
    [field]
  );
  const getSnapshot = useCallback(() => field.accessor.read(), [field]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

const NumberControl: React.FC<{ field: FieldDef; label: string; value: string }> = ({
  field,
  label,
  value
}) => {
  /**
   * 草稿态是必需的：受控输入框直接绑 `value` 的话，用户清空时 `value` 立刻被写回旧值，
   * 一个字符都删不掉。草稿只影响显示，提交仍走 `accessor.write`（设置项即时生效）。
   */
  const [draft, setDraft] = useState(value);

  // 外部改了值（重置键、另一个窗口）→ 输入框跟上。
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="nexus-settings-number">
      <input
        type="number"
        className="nexus-settings-number-input"
        value={draft}
        min={field.min}
        max={field.max}
        step={field.step}
        aria-label={label}
        data-field-input={field.id}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          // 空串不提交 —— 那是「正在改」的中间态，提交它等于把侧栏缩到最小值。
          if (next.trim() !== '') field.accessor.write(next);
        }}
        onBlur={() => setDraft(value)}
      />
      {field.unit ? (
        <span className="nexus-settings-number-unit" aria-hidden="true">
          {field.unit}
        </span>
      ) : null}
    </div>
  );
};

const RadioControl: React.FC<{ field: FieldDef; label: string; t: Translate; value: string }> = ({
  field,
  label,
  t,
  value
}) => (
  <div className="nexus-settings-options" role="radiogroup" aria-label={label}>
    {optionsOf(field, t).map((option) => {
      const checked = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={checked}
          className={`nexus-settings-option${checked ? ' nexus-settings-option-active' : ''}`}
          data-field-option={`${field.id}:${option.value}`}
          onClick={() => field.accessor.write(option.value)}
        >
          {optionLabel(option, t)}
        </button>
      );
    })}
  </div>
);

const SelectControl: React.FC<{ field: FieldDef; label: string; t: Translate; value: string }> = ({
  field,
  label,
  t,
  value
}) => (
  <select
    className="nexus-settings-select"
    value={value}
    aria-label={label}
    data-field-input={field.id}
    onChange={(event) => field.accessor.write(event.target.value)}
  >
    {optionsOf(field, t).map((option) => (
      <option key={option.value} value={option.value}>
        {optionLabel(option, t)}
      </option>
    ))}
  </select>
);

/** 开关用 `role="switch"` 而不是 checkbox：它没有「不确定态」，语义更窄也更准确。 */
const ToggleControl: React.FC<{ field: FieldDef; label: string; value: string }> = ({
  field,
  label,
  value
}) => {
  const on = value === 'true';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`nexus-settings-switch${on ? ' nexus-settings-switch-on' : ''}`}
      data-field-input={field.id}
      onClick={() => field.accessor.write(on ? 'false' : 'true')}
    >
      <span className="nexus-settings-switch-knob" aria-hidden="true" />
    </button>
  );
};

const TextControl: React.FC<{ field: FieldDef; label: string; value: string }> = ({
  field,
  label,
  value
}) => (
  <input
    type="text"
    className="nexus-settings-text"
    value={value}
    aria-label={label}
    data-field-input={field.id}
    onChange={(event) => field.accessor.write(event.target.value)}
  />
);

function controlFor(field: FieldDef, label: string, t: Translate, value: string): React.ReactNode {
  switch (field.control) {
    case 'radio':
      return <RadioControl field={field} label={label} t={t} value={value} />;
    case 'select':
      return <SelectControl field={field} label={label} t={t} value={value} />;
    case 'toggle':
      return <ToggleControl field={field} label={label} value={value} />;
    case 'number':
      return <NumberControl field={field} label={label} value={value} />;
    case 'text':
      return <TextControl field={field} label={label} value={value} />;
    default:
      // `preset` / `action` 没有通用形状，由各自分组的专用组件负责。画不出东西时宁可不画，
      // 也不要画一个点了没反应的控件。
      return null;
  }
}

export const FieldRow: React.FC<{ field: FieldDef }> = ({ field }) => {
  const { t } = useLocale();
  const value = useFieldValue(field);
  const label = t(field.labelKey);
  const description = field.descriptionKey ? t(field.descriptionKey) : null;
  const resettable = field.resetValue !== undefined && value !== field.resetValue;

  return (
    <div className="nexus-settings-field" data-field={field.id}>
      <div className="nexus-settings-field-head">
        <span className="nexus-settings-field-label">{label}</span>
        {resettable ? (
          <button
            type="button"
            className="nexus-settings-field-reset"
            data-field-reset={field.id}
            title={t('settings.reset')}
            aria-label={`${t('settings.reset')} · ${label}`}
            onClick={() => field.accessor.write(field.resetValue as string)}
          >
            {ResetIcon}
          </button>
        ) : null}
      </div>
      {description ? <p className="nexus-settings-field-description">{description}</p> : null}
      {controlFor(field, label, t, value)}
    </div>
  );
};

/** 一个分组的全部字段。分组没有字段时由调用方画空态。 */
export const FieldList: React.FC<{ fields: readonly FieldDef[] }> = ({ fields }) => (
  <>
    {fields.map((field) => (
      <FieldRow key={field.id} field={field} />
    ))}
  </>
);
