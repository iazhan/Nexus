import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HistoryEntry } from '@nexus/core';

/** 历史目录相对工作区根的位置。 */
export const HISTORY_DIR = '.nexus/history';

/**
 * 文档版本历史。
 *
 * ## 为什么放在工作区里，而不是索引库
 *
 * 索引是**派生数据** —— 删了可以重新扫盘重建（P2-05 的验收标准之一）。
 * 历史不是：它记录的是「曾经保存过什么」，那些内容磁盘上已经没有了。
 * 两者混在一起的话，一次索引重建就会把历史一起清空。
 *
 * ## 目录形状
 *
 * 镜像工作区的目录结构，**文件名本身就是历史条目**：
 *
 * ```text
 * <workspace>/.nexus/history/notes/dma.md/20260926T103000Z-a1b2c3d4.md
 * ```
 *
 * 用镜像而不是把相对路径编码进单个文件名：`notes/dma.md` 编成 `notes%2Fdma.md`
 * 之类用户就看不懂了，而历史是**给人看、给人备份的**。
 *
 * 时间戳写成 `YYYYMMDDTHHMMSS`（不含冒号，Windows 文件名不允许），
 * 字典序即时间序，所以 `readdir` 排完就是旧的在前面。
 */
export class HistoryStore {
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 保存前留一份快照。
   *
   * 内容与**已有任一条目**相同时跳过并返回 `null` —— 去重按内容而不是按时间：
   * A → B → A 这种来回改，第二次的 A 不必再存一份。
   *
   * 注意历史里因此**不保留「同一内容在不同时间出现过」这个信息**。
   * 这是刻意的：历史回答的是「曾经保存过哪些内容」，不是「每次保存的时间线」。
   *
   * @returns 写入的条目；内容已有相同的一份时为 `null`
   */
  record(relativePath: string, content: string): HistoryEntry | null {
    const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);

    // 已有一份内容相同的就不重复写
    if (this.list(relativePath).some((entry) => entry.hash === hash)) return null;

    const directory = this.directoryFor(relativePath);
    fs.mkdirSync(directory, { recursive: true });

    const savedAt = formatTimestamp(new Date());
    const fileName = `${savedAt}-${hash}.md`;
    fs.writeFileSync(path.join(directory, fileName), content, 'utf8');

    return { savedAt, hash, sizeBytes: Buffer.byteLength(content, 'utf8') };
  }

  /** 列出某文档的历史版本，**新的在前**。 */
  list(relativePath: string): HistoryEntry[] {
    const directory = this.directoryFor(relativePath);

    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      // 目录不存在 = 这份文档还没有历史，不是错误
      return [];
    }

    const entries: HistoryEntry[] = [];

    for (const name of names) {
      const parsed = parseHistoryFileName(name);
      if (!parsed) continue;

      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(path.join(directory, name)).size;
      } catch {
        // 文件在扫描途中被删了，跳过
        continue;
      }

      entries.push({ savedAt: parsed.savedAt, hash: parsed.hash, sizeBytes });
    }

    // 文件名以时间戳开头，所以字典序倒序就是时间倒序
    return entries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  }

  /** 读某一版的内容。条目不存在时抛错 —— 调用方拿到的是明确失败，不是空字符串。 */
  read(relativePath: string, entry: HistoryEntry): string {
    const file = path.join(this.directoryFor(relativePath), `${entry.savedAt}-${entry.hash}.md`);
    return fs.readFileSync(file, 'utf8');
  }

  /** 历史目录的绝对路径。UI 要展示「历史存在哪」时用。 */
  public directoryFor(relativePath: string): string {
    return path.join(this.workspaceRoot, HISTORY_DIR, ...relativePath.split('/'));
  }
}

/**
 * 生成 `YYYYMMDDTHHMMSS`（UTC）。
 *
 * 用 UTC 而不是本地时间：跨时区/夏令时的机器上，本地时间戳的字典序**不等于**时间序，
 * 而目录里正是靠字典序排序的。
 */
function formatTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** 解析 `<YYYYMMDDTHHMMSS>-<hash8>.md`；不符合形状的返回 `null`。 */
function parseHistoryFileName(name: string): { savedAt: string; hash: string } | null {
  const match = /^(\d{8}T\d{6})-([0-9a-f]{8})\.md$/.exec(name);
  if (!match) return null;

  return { savedAt: match[1]!, hash: match[2]! };
}
