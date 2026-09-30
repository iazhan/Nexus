import React, { useState, useEffect } from 'react';
import { formatShortcut } from '@nexus/command';
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

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const runCommand = (index: number) => {
    const cmd = filteredCommands[index];
    if (!cmd) return;
    onClose();
    cmd.execute();
  };

  // Escape 不在这里处理：它归 `Dialog`，两处都写会让 `preventDefault()` 的先后关系失去意义。
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredCommands.length) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(selectedIndex);
    }
  };

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
        {filteredCommands.map((cmd, idx) => {
          const spec = keybindings.resolve(cmd.id);
          return (
            <li
              key={cmd.id}
              className={`nexus-command-palette-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => runCommand(idx)}
              onMouseEnter={() => setSelectedIndex(idx)}
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
