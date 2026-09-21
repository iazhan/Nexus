export interface Command {
  id: string;
  titleKey: string;
  shortcut?: string; // e.g. 'Mod-S'
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
