/**
 * 主题文件：**一份 base16 scheme + 一段 `nexus:` 扩展块**。
 *
 * ## 为什么是这个形状
 *
 * 用户主题目录里的文件要同时满足两件事：
 *
 * 1. **上游 base16 的文件能直接放进来**（`git clone` tinted-theming 的 schemes 仓库即可用），
 *    所以 16 个槽位那部分必须是标准 base16 形状 —— 一个字段都不能少、不能改名。
 * 2. **Nexus 自己的编辑结果要能存回来。** `NexusThemeScheme` 比 base16 多两个可选字段
 *    （`tuning` / `overrides`），16 个槽位装不下它们；丢了它们，主题编辑器改出来的东西
 *    下次启动就没了。
 *
 * 于是：**base16 部分原样，Nexus 的额外字段收在一个 `nexus:` 顶层块里**。上游工具读这个文件
 * 会忽略 `nexus:`（它们的解析器只认自己那几个键），Nexus 两边都拿得到。
 *
 * ## `id` 在文件里，不是「就是文件名」
 *
 * 文件名是**用户的**：他要能 `git clone` 出一堆 `dracula.yaml`，也要能随手改名。而主题 id 是
 * **选择的锚**（存档里写的是 `user:<id>`）。两者绑死的话，改个文件名就把用户正在用的主题弄丢了。
 *
 * 所以：**没有 `nexus.id` 的文件，id 由调用方从文件名推**（上游文件天然如此）；**Nexus 写出去
 * 的文件一律带上 `nexus.id`**，之后改文件名不影响身份。同 id 的多个文件（明暗两版）由调用方
 * 合成一套主题。
 *
 * ## 只认 `palette` 与 `nexus`，别的一概不读
 *
 * 16 个槽位是**种子**；`nexus.overrides` 是用户在编辑器里明确指定的覆盖值 —— 两者都还要过
 * 派生管线。文件里若出现别的颜色字段（有人手写 `accent: "#..."`），一律不采信：那等于绕过
 * 派生管线，对比度契约当场失效。
 */

import {
  parseBase16,
  quoteYaml,
  serializeBase16,
  stripYamlComment,
  unquote,
  type Base16Error
} from './base16.js';
import { parseColour } from './contrast.js';
import type { NexusThemeScheme, Tuning } from './seeds.js';
import { isUserThemeId } from './user-theme.js';

/** 目录里会被当成主题文件的扩展名。两个都在用（上游两个扩展名混着发）。 */
export const THEME_FILE_EXTENSIONS = ['.yaml', '.yml'] as const;

/** 扩展块里允许出现的调参项。**白名单而不是「读全部数字」** —— 拼错的键会静默变成一个没有效果的字段。 */
const TUNING_KEYS: readonly (keyof Tuning)[] = [
  'surfaceHover',
  'surfaceActive',
  'quote',
  'borderSubtle',
  'borderStrong'
];

export interface ThemeFileExtras {
  /** 文件里写明的主题 id。没有（或认不出）时是 `null`，由调用方从文件名推。 */
  id: string | null;
}

export type ThemeFileParseResult =
  | ({ ok: true; scheme: NexusThemeScheme } & ThemeFileExtras)
  | { ok: false; error: Base16Error };

/**
 * 写一个主题文件。**base16 部分是 `serializeBase16` 的产物**（与导出按钮同源），
 * `nexus:` 块接在它后面。
 *
 * 空的可选字段**不写出来**：写一个空的 `tuning:` 会让「没有调参」与「调参全是默认值」
 * 在文件里长得一样，而两者的语义不同（前者跟着默认值走，后者钉死在写入那一刻的默认值）。
 */
export function serializeThemeFile(id: string, scheme: NexusThemeScheme): string {
  const lines = ['nexus:', `  id: ${quoteYaml(id)}`];

  const tuning = scheme.tuning;
  const tuningKeys = TUNING_KEYS.filter((key) => typeof tuning?.[key] === 'number');
  if (tuningKeys.length > 0) {
    lines.push('  tuning:');
    for (const key of tuningKeys) lines.push(`    ${key}: ${tuning?.[key]}`);
  }

  const overrides = scheme.overrides;
  const overrideKeys = Object.keys(overrides ?? {});
  if (overrideKeys.length > 0) {
    lines.push('  overrides:');
    for (const key of overrideKeys) lines.push(`    ${key}: ${quoteYaml(overrides?.[key] ?? '')}`);
  }

  return `${serializeBase16(scheme)}${lines.join('\n')}\n`;
}

/**
 * 读一个主题文件。base16 那部分完全交给 `parseBase16`（错误码、16 槽校验、hex 归一化都在那里，
 * 只有一份），这里只额外读 `nexus:` 块。
 *
 * `fallbackName` 是文件名 —— 上游的文件里通常有 `name:`，手写的小文件可能没有。
 */
export function parseThemeFile(text: string, fallbackName = 'Imported'): ThemeFileParseResult {
  const parsed = parseBase16(text, fallbackName);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const extras = readNexusBlock(text);
  return {
    ok: true,
    id: extras.id,
    scheme: {
      ...parsed.scheme,
      ...(extras.tuning ? { tuning: extras.tuning } : {}),
      ...(extras.overrides ? { overrides: extras.overrides } : {})
    }
  };
}

interface NexusBlock {
  id: string | null;
  tuning?: Tuning;
  overrides?: Record<string, string>;
}

/**
 * 只认自己写出去的那一种缩进形状：`nexus:` 下两层，键值对，没有列表、没有锚点、没有多文档。
 *
 * 不引 YAML 库的理由与 `base16.ts` 同一条 —— 为二十行扁平数据拉一个解析器（连同它的锚点、
 * 多文档、类型推断语义）不划算，而**这里拒收别的形状是显式的**：认不出的行直接跳过。
 */
function readNexusBlock(text: string): NexusBlock {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^nexus:\s*$/.test(line));
  if (start < 0) return { id: null };

  const block: NexusBlock = { id: null };
  let section: 'tuning' | 'overrides' | null = null;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index] as string);
    if (!line.trim()) continue;
    // 回到顶格 ＝ 扩展块结束。之后的顶层键是别人的地盘。
    if (line === line.trimStart()) break;

    const pair = splitPair(line.trim());
    if (!pair) continue;

    if (line.length - line.trimStart().length <= 2) {
      section = null;
      if (pair.key === 'id') {
        const id = unquote(pair.value);
        if (isUserThemeId(id)) block.id = id;
      } else if (pair.value === '' && (pair.key === 'tuning' || pair.key === 'overrides')) {
        section = pair.key;
      }
      continue;
    }

    if (section === 'tuning') {
      const value = Number(unquote(pair.value));
      if (Number.isFinite(value) && TUNING_KEYS.includes(pair.key as keyof Tuning)) {
        block.tuning = { ...block.tuning, [pair.key]: value };
      }
    } else if (section === 'overrides') {
      const colour = unquote(pair.value);
      if (parseColour(colour)) block.overrides = { ...block.overrides, [pair.key]: colour };
    }
  }

  return block;
}

/** `key: value`。冒号必须在键里（`https://` 这种值不会跑到前面来，因为键是固定的几个）。 */
function splitPair(body: string): { key: string; value: string } | null {
  const at = body.indexOf(':');
  if (at <= 0) return null;
  return { key: body.slice(0, at).trim(), value: body.slice(at + 1).trim() };
}
