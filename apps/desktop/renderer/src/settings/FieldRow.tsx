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
 * 控件覆盖 `radio / select / toggle / number / text / action / group / font / readonly`。
 * `preset` **不在这里**：那是主题卡片网格（专用组件）。
 *
 * `readonly` 是唯一一个 `controlFor` 返回 `null` 的：那一行只画说明与只读值，没有控件。
 *
 * 除控件之外还有一行**只读值**（`FieldDef.readonlyValue`）：说明下面、控件上面的一段文本，
 * 用来把「某个只有主进程算得出的东西」显示出来（索引库路径）。它不是一个控件 ——
 * 没有选中态、没有写入口，所以不走 `controlFor` 那条 switch。
 *
 * 重置键的显隐判据是 `resetValue` 且**当前值不等于它** —— 见 `FieldDef.resetValue` 的注释。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { useLocale } from '../hooks.js';
import { EDITOR_FONT_CANDIDATES, disabledMembers, toggleGroupMember } from './preference-specs.js';
import { optionLabel, optionsOf, type FieldDef } from './registry.js';
import { localFontFamilies } from './system-fonts.js';

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
 *
 * `action` 字段没有访问器，这里必须**照样调用 hook**（不能在调用方条件调用），所以读空串、
 * 订阅空函数。钩子数量恒定，这一点比「省一次订阅」重要。
 */
function useFieldValue(field: FieldDef): string {
  const subscribe = useCallback(
    (listener: () => void) => field.accessor?.subscribe(listener) ?? (() => {}),
    [field]
  );
  const getSnapshot = useCallback(() => field.accessor?.read() ?? '', [field]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * 只读值（`FieldDef.readonlyValue`）。与 `ActionControl` 里那段探测同一个形状：
 * 挂载时取一次，失败与「没有值」都表现为**不画那一行** —— 一行空白比一行 `undefined` 好。
 *
 * 刻意**不重试、不给刷新键**：这个值是工作区路径的纯函数，设置窗口开着的期间它不会变。
 * 加一个刷新键只会让人以为它是个会过期的缓存。
 */
function useReadonlyValue(field: FieldDef): string | null {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    const read = field.readonlyValue;
    if (!read) {
      setValue(null);
      return;
    }
    let alive = true;
    void read().then(
      (next) => {
        if (alive) setValue(next);
      },
      () => {
        if (alive) setValue(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [field]);

  return value;
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
          if (next.trim() !== '') field.accessor?.write(next);
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
          onClick={() => field.accessor?.write(option.value)}
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
    onChange={(event) => field.accessor?.write(event.target.value)}
  >
    {optionsOf(field, t).map((option) => (
      <option key={option.value} value={option.value}>
        {optionLabel(option, t)}
      </option>
    ))}
  </select>
);

/**
 * 开关组：一行一个「名字 + 开关」。
 *
 * **勾选语义与存储语义相反，这是有意的**：存档里存的是「被藏起来的成员」，而用户看到的是
 * 「界面元素」—— 让他对着一份隐藏清单勾选，等于要求他先做一次心算。
 *
 * 每个成员一个 `role="switch"`，与单项开关同一个语义（没有不确定态）。判据属性是
 * `data-field-member="<字段 id>:<成员>"`，与单选组的 `data-field-option` 同形；
 * 区别是这里**每个成员都会画出来**，单选组只画一个选中项。
 *
 * 成员 id 与顺序取自 `FieldDef.options`（`optionsOf`），所以「什么顺序写进存档」与
 * 「界面上什么顺序」是同一份表 —— 两处各写一遍的话，规范化会按另一个顺序拼。
 * 这也意味着**组不能用运行期生成的 `optionsOf`**：顺序会变，规范化就不再稳定。
 */
const GroupControl: React.FC<{ field: FieldDef; label: string; t: Translate; value: string }> = ({
  field,
  label,
  t,
  value
}) => {
  const members = optionsOf(field, t);
  const memberIds = members.map((option) => option.value);
  const off = disabledMembers(memberIds, value);

  return (
    <div
      className="nexus-settings-group"
      role="group"
      aria-label={label}
      data-field-input={field.id}
    >
      {members.map((option) => {
        const on = !off.includes(option.value);
        return (
          <div className="nexus-settings-group-row" key={option.value}>
            <span className="nexus-settings-group-name">{optionLabel(option, t)}</span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={optionLabel(option, t)}
              className={`nexus-settings-switch${on ? ' nexus-settings-switch-on' : ''}`}
              data-field-member={`${field.id}:${option.value}`}
              onClick={() =>
                field.accessor?.write(toggleGroupMember(memberIds, value, option.value))
              }
            >
              <span className="nexus-settings-switch-knob" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

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
      onClick={() => field.accessor?.write(on ? 'false' : 'true')}
    >
      <span className="nexus-settings-switch-knob" aria-hidden="true" />
    </button>
  );
};

/**
 * 文本输入框。
 *
 * 草稿态与 `NumberControl` 同一个理由：受控输入框直接绑 `value` 的话，用户清空时
 * `value` 立刻被写回旧值，一个字符都删不掉。
 *
 * 比数值框多一层**聚焦期间不跟外部同步**：这两项文本的空串会被 `parse` 落回默认值，
 * 于是「清空 → 存档变回默认 → `value` 变了 → 输入框跳回默认值」会在用户还没打完字时发生。
 * 数值框没这个问题（它的空串不提交），但这条防的是同一类事，多一层判据比逐项解释便宜。
 */
const TextControl: React.FC<{ field: FieldDef; label: string; value: string }> = ({
  field,
  label,
  value
}) => {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  return (
    <input
      type="text"
      className="nexus-settings-text"
      value={draft}
      aria-label={label}
      data-field-input={field.id}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={() => {
        editing.current = false;
        // 离开输入框时回到**存档里的值** —— 留空被落回默认值，这里就会显示默认值，
        // 用户不必猜「我清空了，现在到底存的是什么」。
        setDraft(value);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        field.accessor?.write(event.target.value);
      }}
    />
  );
};

/**
 * 字体家族：**可搜索的下拉**（输入框 + 自绘候选列表）。
 *
 * **为什么不用 `<datalist>`**（当天做当天改掉）：Chromium 只在**输入时**才弹建议，
 * 点输入框本体不弹，只有右端那个没有任何提示的小箭头能弹 —— 反馈就是「字体下拉框没有可选项」。
 * 原生控件在这里的可用性不够，不是没接好。
 *
 * **为什么不用 `<select>`**：能用的字体取决于这台机器装了什么，静态表列不全；而
 * 「哪些字体有中文字形」在浏览器里**问不出来**（`document.fonts.check` 对系统字体恒为真，
 * 连不存在的字体名也是），所以自动滤出一条干净清单做不到。于是把两件事拆开：
 * **输入框保证任意家族名都能用**，列表只负责给一份可搜索的候选。
 *
 * 候选顺序：三档预设的**显示名** → 精选清单 → 本机枚举（`localFontFamilies()`，
 * 异步、拿不到就少一截）。预设在最前，因为它们是唯一「一定可用」的几个值。
 *
 * **三档预设存的是键**（`default` / `sans` / `serif`），输入框与列表里显示的是它们的译文 ——
 * 让用户对着 `default` 猜是什么意思，或者把 `default` 当成字体名存下来，都是把内部表示漏出去。
 *
 * **不画按钮**：设置页有一份「每枚按钮都必须落进已知清单」的哨兵
 * （`settings-view.test.tsx`）。选项因此是 `<li role="option">` —— 它们本来也不该是按钮，
 * 按钮的语义是「按一下做一件事」，而这里是在一组值里挑一个。
 */
const FontControl: React.FC<{ field: FieldDef; label: string; t: Translate; value: string }> = ({
  field,
  label,
  t,
  value
}) => {
  const presets = optionsOf(field, t);

  /** 值 → 界面文本。预设显示译文，其余原样。 */
  const labelOf = (raw: string): string => {
    const preset = presets.find((option) => option.value === raw);
    return preset ? optionLabel(preset, t) : raw;
  };

  /** 界面文本 → 值。选中预设的**译文**要写回它的键。 */
  const valueOf = (text: string): string =>
    presets.find((option) => optionLabel(option, t) === text)?.value ?? text;

  const [installed, setInstalled] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState(() => labelOf(value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [flip, setFlip] = useState(false);
  /**
   * 这一次聚焦之后用户改过输入框没有。**不能拿「文本是否等于当前值的显示名」当判据** ——
   * 这一项是边打字边写盘的（与设置页其它文本项一致），所以敲下第一个字符时 `draft` 就已经
   * 等于新值的显示名了，那个判据恒为真，过滤永远不生效。
   */
  const [touched, setTouched] = useState(false);
  const editing = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // 本机枚举只在挂载时问一次，拿不到就是空数组（候选少一截，输入框照用）。
  useEffect(() => {
    let alive = true;
    void localFontFamilies().then((families) => {
      if (alive) setInstalled(families);
    });
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [
      ...presets.map((option) => optionLabel(option, t)),
      ...EDITOR_FONT_CANDIDATES,
      ...installed
    ]) {
      const key = name.trim().toLocaleLowerCase();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }, [presets, t, installed]);

  /**
   * 过滤条件。**只有用户改过输入框才滤**：刚聚焦时框里是当前字体的名字，照它过滤只会剩一条 ——
   * 用户点开是想看全部。清空输入框同样得到全部（空串匹配一切）。
   */
  const query = touched ? draft.trim().toLocaleLowerCase() : '';
  const matches = useMemo(
    () =>
      query === ''
        ? candidates
        : candidates.filter((name) => name.toLocaleLowerCase().includes(query)),
    [candidates, query]
  );

  // 外部改了值（重置键、另一个窗口）→ 输入框跟上；**正在打字时不跟**，与 `TextControl` 同理。
  useEffect(() => {
    if (editing.current) return;
    const preset = presets.find((option) => option.value === value);
    setDraft(preset ? optionLabel(preset, t) : value);
  }, [value, presets, t]);

  // 高亮项跟着键盘走时要让它可见，否则按了方向键看不出选中了什么。
  useEffect(() => {
    if (!open) return;
    const node = list.current?.children[active];
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const listId = `nexus-font-candidates-${field.id}`;

  function openList(): void {
    const current = matches.findIndex((name) => name === labelOf(value));
    setActive(current >= 0 ? current : 0);
    // 设置内容区是 `overflow: auto`，往下弹会被裁掉 —— 贴着窗口下半部分时改成往上弹。
    const rect = root.current?.getBoundingClientRect();
    setFlip(rect !== undefined && rect.bottom + 260 > window.innerHeight);
    setOpen(true);
  }

  function commit(name: string): void {
    editing.current = false;
    setTouched(false);
    const next = valueOf(name);
    field.accessor?.write(next);
    // 显式回填而不等 store 的通知：写进去的值与原来相同时通知不会发，那时草稿会停在
    // 用户敲了一半的文本上。
    setDraft(labelOf(next));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (matches.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + delta + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter') {
      if (!open || !matches[active]) return;
      event.preventDefault();
      commit(matches[active]);
      return;
    }
    if (event.key === 'Escape' && open) {
      // 必须 `preventDefault`：设置窗口的 Escape 关窗挂在 `window` 上，它只看
      // `defaultPrevented`。不拦的话「关下拉」会连窗口一起关掉。
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="nexus-settings-font" ref={root}>
      <input
        type="text"
        className="nexus-settings-text"
        value={draft}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        data-field-input={field.id}
        onFocus={() => {
          editing.current = true;
          setTouched(false);
          openList();
        }}
        onBlur={() => {
          editing.current = false;
          setTouched(false);
          setOpen(false);
          // 离开时回到**存档里的值**：空串被落回默认档，这里就显示默认档的译文，
          // 用户不必猜「我清空了，现在到底存的是什么」。
          setDraft(labelOf(value));
        }}
        onChange={(event) => {
          const next = event.target.value;
          editing.current = true;
          setTouched(true);
          setActive(0);
          setDraft(next);
          setOpen(true);
          // 值域是开放的，这一层不拦 —— 敲进去什么就存什么（预设的译文除外）。
          field.accessor?.write(valueOf(next));
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul
          ref={list}
          id={listId}
          className={`nexus-settings-font-list${flip ? ' nexus-settings-font-list-up' : ''}`}
          role="listbox"
          aria-label={label}
          data-field-candidates={field.id}
        >
          {matches.length === 0 ? (
            <li className="nexus-settings-font-empty" role="presentation">
              {t('settings.editor.fontFamilyNoMatch')}
            </li>
          ) : (
            matches.map((name, index) => (
              <li
                key={name}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`nexus-settings-font-option${
                  index === active ? ' nexus-settings-font-option-active' : ''
                }`}
                data-font-option={name}
                // `preventDefault` 保住焦点：不拦的话输入框先失焦、列表先关，这一下点了个空。
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(name);
                }}
                onMouseEnter={() => setActive(index)}
              >
                {name}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
};

/**
 * 动作按钮。三种状态：可用、探测中（禁用）、被挡住（禁用 + 一行原因）。
 *
 * 探测是**异步**的 —— 「当前有没有工作区」要问主进程。只探一次：设置窗口是短命窗口，
 * 它开着的期间工作区不会变。
 *
 * 跑完之后给一行短暂的回执。没有它，这个按钮的效果落在**另一个窗口**（重建索引会让主窗口的
 * 侧栏刷新、打开目录会弹资源管理器），在当前窗口里点了像没反应。
 */
const ActionControl: React.FC<{ field: FieldDef; t: Translate }> = ({ field, t }) => {
  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcomeKey, setOutcomeKey] = useState<string | null>(null);

  useEffect(() => {
    if (!field.probe) {
      setBlockedKey(null);
      return;
    }
    let alive = true;
    void field.probe().then(
      (reason) => {
        if (alive) setBlockedKey(reason);
      },
      () => {
        // 探测本身失败不该把按钮永久锁死 —— 让用户点，真出错时由回执那一行说明。
        if (alive) setBlockedKey(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [field]);

  return (
    /* `aria-live` 挂在**常驻**的容器上，不是那行回执自己 —— 读屏只在「已经存在的 live region
       内容变化」时播报；动态插入一个带 `role="status"` 的元素是不响的。 */
    <div className="nexus-settings-action" aria-live="polite">
      <button
        type="button"
        className="nexus-settings-action-button"
        data-field-action={field.id}
        disabled={blockedKey !== null || pending}
        onClick={() => {
          if (pending) return;
          setPending(true);
          setOutcomeKey(null);
          void Promise.resolve(field.run?.()).then(
            () => setOutcomeKey('settings.action.done'),
            () => setOutcomeKey('settings.action.failed')
          ).finally(() => setPending(false));
        }}
      >
        {t(field.actionLabelKey ?? field.labelKey)}
      </button>
      {blockedKey ? (
        <p className="nexus-settings-action-note" data-field-blocked={field.id}>
          {t(blockedKey)}
        </p>
      ) : outcomeKey ? (
        <p className="nexus-settings-action-note" data-field-outcome={field.id}>
          {t(outcomeKey)}
        </p>
      ) : null}
    </div>
  );
};

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
    case 'action':
      return <ActionControl field={field} t={t} />;
    case 'group':
      return <GroupControl field={field} label={label} t={t} value={value} />;
    case 'font':
      return <FontControl field={field} label={label} t={t} value={value} />;
    case 'readonly':
      // 只读值那一行由 `FieldRow` 自己画（它在控件**上方**，与控件不是同一个位置），
      // 所以这里什么都不画。返回 `null` 而不是省略这个 case：`FieldControl` 是联合类型，
      // 少一个分支编译器不会报错，但加控件的人会以为漏了。
      return null;
    default:
      // `preset` 是主题卡片网格，由外观分组的专用组件负责。画不出东西时宁可不画，
      // 也不要画一个点了没反应的控件。
      return null;
  }
}

/**
 * 路径在分隔符**之后**插入 `<wbr>`。
 *
 * CSS 不认 `\` 与 `/` 是断行机会，所以长路径只能在任意字符处断开（那是 `word-break: break-all`
 * 的效果）—— 断点落在目录名中间，用户没法按层级扫读。插 `<wbr>` 把断点挪到分隔符后。
 *
 * 多行文本（诊断信息）原样返回：它自己带换行，`white-space: pre-wrap` 会处理。
 */
function withBreakOpportunities(value: string): React.ReactNode {
  if (value.includes('\n')) return value;
  const parts = value.split(/(?<=[\\/])/);
  if (parts.length < 2) return value;
  return parts.map((part, index) => (
    <React.Fragment key={`${index}-${part}`}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </React.Fragment>
  ));
}

export const FieldRow: React.FC<{ field: FieldDef }> = ({ field }) => {
  const { t } = useLocale();
  const value = useFieldValue(field);
  const readonlyValue = useReadonlyValue(field);
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
            onClick={() => field.accessor?.write(field.resetValue as string)}
          >
            {ResetIcon}
          </button>
        ) : null}
      </div>
      {description ? <p className="nexus-settings-field-description">{description}</p> : null}
      {/* 只读值排在说明**下面**、控件上面：它是对说明里那句「落在哪」的具体回答，
          离说明近、离按钮也近。它不可选、不可改，所以是一段文本而不是输入框。 */}
      {readonlyValue !== null ? (
        <p className="nexus-settings-field-readonly" data-field-readonly={field.id}>
          {withBreakOpportunities(readonlyValue)}
        </p>
      ) : null}
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
