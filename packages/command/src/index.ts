export interface Command {
  id: string;
  titleKey: string;
  /**
   * **默认**快捷键（如 `Mod-S`）。用户改过的绑定存在覆盖表里 —— 生效值要问
   * `createKeybindingTable().resolve(id)`，不要直接读这个字段。
   *
   * 留着它有两个用处：默认表的第二份载体（覆盖表丢了也能恢复），以及命令面板在
   * 拿不到宿主默认表时的兜底显示。
   */
  shortcut?: string;
  execute: (...args: any[]) => void;
}

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  registerCommand(command: Command): () => void {
    this.commands.set(command.id, command);
    return () => {
      this.commands.delete(command.id);
    };
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  getCommand(id: string): Command | undefined {
    return this.commands.get(id);
  }

  executeCommand(id: string, ...args: any[]): void {
    const cmd = this.commands.get(id);
    if (!cmd) {
      throw new Error(`Command '${id}' not found`);
    }
    cmd.execute(...args);
  }
}

export {
  isApplePlatform,
  parseShortcut,
  formatShortcut,
  matchesShortcut,
  normalizeShortcut,
  shortcutFromEvent,
  type ShortcutDescriptor,
  type KeyboardShortcutEvent
} from './shortcut.js';

export {
  UNBOUND,
  parseKeybindingOverrides,
  serializeKeybindingOverrides,
  createKeybindingTable,
  type KeybindingOverrides,
  type KeybindingEntry,
  type KeybindingTable
} from './keybindings.js';
