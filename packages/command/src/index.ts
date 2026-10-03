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
  /**
   * 这条命令**此刻**能不能执行。缺省＝总是可以。
   *
   * 菜单能靠自己的 `disabled` 表达「现在不行」，命令面板没有对应物 —— 于是那些
   * 有条件才生效的命令在面板里只能装作一直可用，按下去毫无反应。用户会以为自己按错了。
   * 所以可用性要由命令自己声明，两处消费同一份判据。
   *
   * 判据写在这里而不是调用方，是因为**只有注册命令的那一处知道**它在等什么条件；
   * 面板与菜单各自再推一遍，必然漂。
   *
   * `executeCommand` 不做拦截（它是原样分发）—— 拦截发生在知道「可用性」的那一层：
   * 面板跳过灰项、菜单不派发。自己派发前先问一次 `isEnabled?.() ?? true`。
   */
  isEnabled?: () => boolean;
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
