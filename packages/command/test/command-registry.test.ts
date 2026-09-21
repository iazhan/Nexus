import { describe, it, expect, vi } from 'vitest';
import { CommandRegistry, Command } from '../src/index.js';

describe('CommandRegistry', () => {
  it('registers and executes a command', () => {
    const registry = new CommandRegistry();
    const execute = vi.fn();
    
    const cmd: Command = {
      id: 'test.cmd',
      titleKey: 'cmd.test',
      execute
    };

    const unsubscribe = registry.registerCommand(cmd);
    expect(registry.getCommands()).toContain(cmd);

    registry.executeCommand('test.cmd', 'arg1', 2);
    expect(execute).toHaveBeenCalledWith('arg1', 2);

    unsubscribe();
    expect(registry.getCommands()).not.toContain(cmd);
  });

  it('throws or handles execution of unknown command gracefully', () => {
    const registry = new CommandRegistry();
    expect(() => registry.executeCommand('unknown')).toThrowError(/not found/);
  });

  it('allows looking up commands by id', () => {
    const registry = new CommandRegistry();
    const cmd: Command = { id: 'test', titleKey: 'test', execute: () => {} };
    registry.registerCommand(cmd);
    
    expect(registry.getCommand('test')).toBe(cmd);
    expect(registry.getCommand('unknown')).toBeUndefined();
  });
});
