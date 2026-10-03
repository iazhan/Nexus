import React, { useState, useEffect } from 'react';
import { formatShortcut, type Command } from '@nexus/command';
import { commandRegistry } from './platform.js';
import { useLocale, useKeybindingTable } from './hooks.js';
import { Dialog } from './components/Dialog.js';

/**
 * 命令面板。外壳（遮罩 / 焦点陷阱 / Escape / 焦点归还）交给 `Dialog` —— 这层原本自己实现了
 * 一半：Escape 挂在输入框上、遮罩点击关闭，但没有 `role="dialog"`、没有焦点陷阱、关掉之后
 * 焦点不回原位。
 *
 * 快捷键标签走**生效表**而不是命令自带的 `shortcut` 字段：后者是默认值，用户改过绑定之后
 * 面板上还显示旧组合键就是骗人。
 *
 * ## 不可用的命令要灰显、且键盘跳过
 *
 * `isEnabled()` 为假的命令（如「在工作区中打开」在没开文档时）**留在列表里** ——
 * 藏掉会让人以为命令不存在。但它既不能执行、也不该被方向键选中：
 * 选中态是「按回车会发生什么」的承诺，让一个按下去没反应的项获得选中态，
 * 等于把「点了没反应」从鼠标挪到了键盘上。
 *
 * 所以选中下标走 `selectable` 数组（只含可用项），渲染仍按完整列表 ——
 * 两个下标的含义不同，别混用。
 */
export const CommandPalette: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const { t } = useLocale();
  const keybindings = useKeybindingTable();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allCommands = commandRegistry.getCommands();
  const filteredCommands = allCommands.filter(cmd =>
    t(cmd.titleKey).toLowerCase().includes(query.toLowerCase()) ||
    cmd.id.toLowerCase().includes(query.toLowerCase())
  );

  // 可执行的那些（`isEnabled` 缺省为真）。选中下标是**它**的下标，不是 `filteredCommands` 的。
  const selectable = filteredCommands.filter(cmd => cmd.isEnabled?.() ?? true);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // 查询把选中项滤掉之后，下标可能越界 —— 夹回去而不是留一个不存在的选中态。
  useEffect(() => {
    setSelectedIndex(prev => (prev < selectable.length ? prev : Math.max(0, selectable.length - 1)));
  }, [selectable.length]);

  const runCommand = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.execute();
  };

  // Escape 不在这里处理：它归 `Dialog`，两处都写会让 `preventDefault()` 的先后关系失去意义。
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectable.length === 0) return;
      setSelectedIndex(i => (i + 1) % selectable.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectable.length === 0) return;
      setSelectedIndex(i => (i - 1 + selectable.length) % selectable.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(selectable[selectedIndex]);
    }
  };

  const selectedId = selectable[selectedIndex]?.id ?? null;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      label={t('cmd.palette')}
      placement="top"
      panelClassName="nexus-command-palette"
      initialFocusSelector=".nexus-command-palette-input"
    >
      <input
        className="nexus-command-palette-input"
        value={query}
        onChange={e => {
          setQuery(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={t('cmd.placeholder') || 'Search commands...'}
      />
      <ul className="nexus-command-palette-list">
        {filteredCommands.map(cmd => {
          const enabled = cmd.isEnabled?.() ?? true;
          const isSelected = enabled && cmd.id === selectedId;
          const spec = keybindings.resolve(cmd.id);
          return (
            <li
              key={cmd.id}
              className={`nexus-command-palette-item${isSelected ? ' selected' : ''}${
                enabled ? '' : ' nexus-command-palette-item-disabled'
              }`}
              data-command-id={cmd.id}
              data-disabled={enabled ? undefined : 'true'}
              aria-disabled={enabled ? undefined : true}
              onClick={() => {
                if (!enabled) return;
                runCommand(cmd);
              }}
              onMouseEnter={() => {
                if (!enabled) return;
                setSelectedIndex(selectable.findIndex(item => item.id === cmd.id));
              }}
            >
              <span className="nexus-command-title">{t(cmd.titleKey)}</span>
              {spec && <span className="nexus-command-shortcut">{formatShortcut(spec)}</span>}
            </li>
          );
        })}
        {filteredCommands.length === 0 && (
          <li className="nexus-command-palette-empty">{t('cmd.empty')}</li>
        )}
      </ul>
    </Dialog>
  );
};
