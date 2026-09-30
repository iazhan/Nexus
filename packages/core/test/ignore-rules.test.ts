import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_IGNORED_DIRECTORY_NAMES,
  parseIgnoreRules,
  shouldIgnoreDirectory
} from '../src/workspace/ignore-rules.js';

describe('parseIgnoreRules · 归一化', () => {
  it('逗号与换行都当分隔符 —— 粘贴一段一行一条的清单不该整段失效', () => {
    expect(parseIgnoreRules('drafts, private')).toEqual(['drafts', 'private']);
    expect(parseIgnoreRules('drafts\nprivate')).toEqual(['drafts', 'private']);
    expect(parseIgnoreRules('drafts\r\nprivate')).toEqual(['drafts', 'private']);
    expect(parseIgnoreRules('drafts, \n private')).toEqual(['drafts', 'private']);
  });

  it('空串、空白、纯分隔符都得到空规则表', () => {
    expect(parseIgnoreRules(null)).toEqual([]);
    expect(parseIgnoreRules(undefined)).toEqual([]);
    expect(parseIgnoreRules('')).toEqual([]);
    expect(parseIgnoreRules('   ')).toEqual([]);
    expect(parseIgnoreRules(' , ,\n, ')).toEqual([]);
  });

  it('反斜杠转正斜杠 —— Windows 用户会顺手敲 \\', () => {
    expect(parseIgnoreRules('notes\\private')).toEqual(['notes/private']);
  });

  it('去掉 ./ 与首尾斜杠，让同一个目录的几种写法归一', () => {
    expect(parseIgnoreRules('./drafts/')).toEqual(['drafts']);
    expect(parseIgnoreRules('/drafts')).toEqual(['drafts']);
    expect(parseIgnoreRules('notes//private/')).toEqual(['notes/private']);
  });

  it('丢掉盘符前缀：忽略规则永远相对工作区根', () => {
    expect(parseIgnoreRules('C:/notes/drafts')).toEqual(['notes/drafts']);
    expect(parseIgnoreRules('d:/drafts')).toEqual(['drafts']);
  });

  it('丢掉含 . 或 .. 段的规则 —— 那是路径穿越写法，做忽略规则没有意义', () => {
    expect(parseIgnoreRules('../outside')).toEqual([]);
    expect(parseIgnoreRules('notes/../drafts')).toEqual([]);
    expect(parseIgnoreRules('notes/./drafts')).toEqual([]);
  });

  it('大小写不敏感去重，保留第一次出现的写法', () => {
    expect(parseIgnoreRules('Drafts, drafts, DRAFTS')).toEqual(['Drafts']);
  });

  it('保留大小写原样 —— 用户看到的应该是自己写的样子', () => {
    expect(parseIgnoreRules('MyDrafts')).toEqual(['MyDrafts']);
  });
});

describe('shouldIgnoreDirectory · 内置规则', () => {
  it('点开头的目录一律跳过', () => {
    expect(shouldIgnoreDirectory('.git', '.git', [])).toBe(true);
    expect(shouldIgnoreDirectory('.obsidian', '.obsidian', [])).toBe(true);
    expect(shouldIgnoreDirectory('.nexus', '.nexus', [])).toBe(true);
  });

  it('四个内置的构建产物目录名都跳过', () => {
    for (const name of BUILT_IN_IGNORED_DIRECTORY_NAMES) {
      expect(shouldIgnoreDirectory(name, name, [])).toBe(true);
    }
  });

  it('内置规则大小写不敏感 —— 与用户规则同一条口径，避免没法解释的差别', () => {
    expect(shouldIgnoreDirectory('Node_Modules', 'Node_Modules', [])).toBe(true);
    expect(shouldIgnoreDirectory('DIST', 'DIST', [])).toBe(true);
  });

  it('普通目录默认不跳过', () => {
    expect(shouldIgnoreDirectory('notes', 'notes', [])).toBe(false);
    expect(shouldIgnoreDirectory('src', 'src', [])).toBe(false);
  });
});

describe('shouldIgnoreDirectory · 用户规则', () => {
  it('不带斜杠的规则按目录名比，任意层级都命中', () => {
    const rules = parseIgnoreRules('drafts');
    expect(shouldIgnoreDirectory('drafts', 'drafts', rules)).toBe(true);
    expect(shouldIgnoreDirectory('drafts', 'notes/drafts', rules)).toBe(true);
    expect(shouldIgnoreDirectory('notes', 'notes', rules)).toBe(false);
  });

  it('带斜杠的规则按相对路径比，只命中那一条', () => {
    const rules = parseIgnoreRules('notes/private');
    expect(shouldIgnoreDirectory('private', 'notes/private', rules)).toBe(true);
    // 同名的目录在别处就不该被跳过 —— 这正是「按路径」与「按名字」的区别
    expect(shouldIgnoreDirectory('private', 'archive/private', rules)).toBe(false);
    expect(shouldIgnoreDirectory('notes', 'notes', rules)).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(shouldIgnoreDirectory('Drafts', 'Drafts', parseIgnoreRules('drafts'))).toBe(true);
    expect(shouldIgnoreDirectory('drafts', 'drafts', parseIgnoreRules('Drafts'))).toBe(true);
  });

  it('规则表为空时只有内置规则生效', () => {
    expect(shouldIgnoreDirectory('drafts', 'drafts', [])).toBe(false);
  });

  it('跳过一个目录等于跳过它的整棵子树 —— 所以不需要前缀匹配', () => {
    // 顶层 `notes` 被跳过之后，walker 根本不会走进 `notes/private`，
    // 这条用例钉住的是「不要为了这个再引入一套前缀逻辑」。
    const rules = parseIgnoreRules('notes');
    expect(shouldIgnoreDirectory('notes', 'notes', rules)).toBe(true);
  });
});
