/**
 * 版本历史的**保留上限** —— 每个文档最多留多少份快照。
 *
 * ## 为什么会有这个文件（推翻了一条旧决策）
 *
 * `docs/README.md` 原本写着「清理策略（保留 N 份 / 按时间）**明确不做** —— 等真实使用量出来再定」。
 * 那句话在 2026-09-30 被推翻：**做成设置项正好解掉它自己的阻塞** —— 不必猜「N 该是多少」，
 * 用户按自己的使用量定；默认值只是一个起点，不是一个判断。
 *
 * ## 为什么按数量，不按时间
 *
 * 按时间**约束不了空间**：一个文档一天改 500 次，30 天窗口里就是 500 份。
 * 按数量则是「这个文档最多占 N 份的空间」，上限可算。而目录本身已经按时间排好序
 * （`HistoryStore.list` 新的在前），所以「按数量」取尾巴即可，不需要额外扫描。
 *
 * ## 失败方向必须是「不删」
 *
 * 历史是那些内容**在本机唯一的副本**（磁盘上那份已经没了），删掉不可逆。
 * 所以凡是「值不认识 / 读坏了 / 缺字段」，一律当**不清理** —— 回落到某个具体数字意味着
 * 「存档里一个坏值就开始删东西」，而那个后果没人撤销得了。
 */

import type { HistoryEntry } from '../types/file.js';

/**
 * 设置值里表示「不清理」的那一个。
 *
 * 用词而不是 `'0'`：`0` 在「份数」这个语境里读起来像「一份都不留」，与它实际的语义正相反。
 */
export const HISTORY_RETENTION_UNLIMITED = 'unlimited';

/**
 * 可选档位。**「不清理」排在最前** —— 它是最保守的一档。
 *
 * 档位而不是数字输入框：这一项会**删数据**，一个手滑填进去的 `5` 比一个必须主动选中的档位危险得多。
 * 上限 200 是刻意的：再往上，这份「上限」就不再约束任何现实中的用法了。
 */
export const HISTORY_RETENTION_OPTIONS: readonly string[] = [
  HISTORY_RETENTION_UNLIMITED,
  '20',
  '50',
  '100',
  '200'
];

/**
 * 默认档位。
 *
 * 100 是「宽到现实中没人撞得上、窄到能挡住病态增长」的那一档：一个文档要改一千次才会被删掉
 * 最旧的九百份，而那时用户早不需要它们了。撞上它的代价（最旧的版本没了）远低于不设上限的代价
 * （`.nexus` 无限膨胀，而用户是在磁盘报警时才知道）。
 */
export const HISTORY_RETENTION_DEFAULT = '100';

/**
 * 设置值 → 上限。`null` 表示**不清理**。
 *
 * 认不出的值（`null` / 空串 / `'abc'` / `'-1'` / `'1.5'`）一律回落到不清理，理由见文件头。
 */
export function parseHistoryRetention(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw === HISTORY_RETENTION_UNLIMITED) return null;

  const limit = Number(raw);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/**
 * 从「新的在前」的条目表里挑出该删的那些 —— 即超出上限的那一截尾巴。
 *
 * 纯函数，不碰文件系统：删文件是调用方的事，这里只回答「删哪些」。
 * `entries` **必须新的在前**（`HistoryStore.list` 的契约），否则删掉的是最新的那几份。
 *
 * `retention <= 0` 也返回空：那是「把上限写成了零」的坏值，`slice(0)` 会把整个历史清空 ——
 * 一个读坏了的值不该有这种能力。
 */
export function entriesToTrim(
  entries: readonly HistoryEntry[],
  retention: number | null
): HistoryEntry[] {
  if (retention === null || retention <= 0) return [];
  return entries.slice(retention);
}
