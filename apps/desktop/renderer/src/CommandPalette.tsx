import React, { useState, useEffect, useRef } from 'react';
import { commandRegistry } from './platform.js';
import { useLocale } from './hooks.js';
import { formatShortcut } from './shortcut.js';


export const CommandPalette: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allCommands = commandRegistry.getCommands();
  const filteredCommands = allCommands.filter(cmd => 
    t(cmd.titleKey).toLowerCase().includes(query.toLowerCase()) || 
    cmd.id.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredCommands.length) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filteredCommands[selectedIndex];
      if (cmd) {
        onClose();
        cmd.execute();
      }
    }
  };

  return (
    <div className="nexus-command-palette-backdrop" onClick={onClose}>
      <div className="nexus-command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
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
          {filteredCommands.map((cmd, idx) => (
            <li 
              key={cmd.id} 
              className={`nexus-command-palette-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                onClose();
                cmd.execute();
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="nexus-command-title">{t(cmd.titleKey)}</span>
              {cmd.shortcut && (
                <span className="nexus-command-shortcut">{formatShortcut(cmd.shortcut)}</span>
              )}
            </li>
          ))}
          {filteredCommands.length === 0 && (
            <li className="nexus-command-palette-empty">No commands found</li>
          )}
        </ul>
      </div>
    </div>
  );
};
