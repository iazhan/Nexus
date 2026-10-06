/**
 * 共同祖先账本（base ledger）：记住「本机最后一次读到或写到磁盘的内容」。
 *
 * ## 它解决什么
 *
 * 三路合并要一个**共同祖先**才说得出「谁改的」。没有它，两路对齐只能说「两边不一样」，
 * 每一行都只能默认「保留我这边」，用户得逐块自己推理（见 `packages/markdown/src/align.ts`）。
 *
 * ## 它是缓存，不是事实源
 *
 * 住在 `<userData>/concord-ledger/<工作区摘要>/`，**不在工作区里**。由此推出三条纪律：
 *
 * - **任何错误只记日志，不上抛。** 调用方拿 `null` 就是「没有祖先」→ 降级成两路对齐，
 *   而不是失败。这个文件里没有一处 `throw`。
 * - **永不阻塞保存。** 调用方 fire-and-forget，写入在这里自己串行排队。
 * - **读 blob 时校验哈希。** 对不上说明磁盘被外部改过或文件截断 —— 当没有，不当内容。
 *
 * ## 内容寻址
 *
 * `index.json` 记 `相对路径 → { hash, at }`，内容按 `blobs/<sha256>` 存。同一份内容只落一份盘
 * （改回去又改回来不堆副本），读的时候顺手校验。写新条目时若旧 blob 不再被任何条目引用就删掉 ——
 * 索引很小（一个工作区的文档数），扫一遍比维护引用计数可靠。
 *
 * ## 相对路径是键
 *
 * 用工作区相对路径（`/` 分隔）而不是绝对路径：工作区整个搬走之后账本仍然对得上。
 * 归一化由调用方负责（`index-path.ts` 的 `workspaceKey` 是工作区级的，这里是文档级的）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logError } from './logger.js';

const INDEX_FILE = 'index.json';
const BLOBS_DIR = 'blobs';
const INDEX_VERSION = 1;

interface LedgerEntry {
  /** 内容的 sha256（hex）。blob 的文件名就是它。 */
  hash: string;
  /** 记下这一条的时刻（ms）。目前只用于排查，不参与判定。 */
  at: number;
}

interface LedgerIndex {
  version: number;
  entries: Record<string, LedgerEntry>;
}

export class ConcordLedger {
  readonly directory: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  /**
   * 记住某个文档此刻在磁盘上的内容。
   *
   * **刻意不返回 promise**：调用方（保存路径）不该为一件缓存的事去 await。内部串行排队，
   * 所以并发调用不会把 `index.json` 写坏。失败只记日志。
   */
  record(relativePath: string, content: string): void {
    this.#queue = this.#queue.then(() => this.#write(relativePath, content)).catch((err) => {
      logError('[Nexus Ledger] 记共同祖先失败（不影响保存）:', err);
    });
  }

  /**
   * 取共同祖先。**没有 / 坏了 / 读不出来一律 `null`**，调用方据此降级成两路对齐。
   *
   * 同步读：合并发生的那一刻就要答案，而账本很小（一条索引 + 一个 blob）。
   */
  getBase(relativePath: string): string | null {
    try {
      const entry = this.#readIndex().entries[relativePath];
      if (!entry) return null;

      const content = fs.readFileSync(path.join(this.directory, BLOBS_DIR, entry.hash), 'utf8');
      // 哈希对不上 ＝ blob 被外部动过或截断了。当没有，不当内容。
      return hashOf(content) === entry.hash ? content : null;
    } catch {
      return null;
    }
  }

  /** 文档被删时丢掉它的条目，顺带回收它的 blob。 */
  forget(relativePath: string): void {
    this.#queue = this.#queue.then(() => this.#forget(relativePath)).catch((err) => {
      logError('[Nexus Ledger] 丢共同祖先失败（不影响删除）:', err);
    });
  }

  /**
   * 文档改名：把条目**搬到新键**上。
   *
   * 不用「丢掉旧的 + 重记新的」代替 —— 那两件事中间有个窗口，此时既没有旧条目也没有新条目，
   * 而重记还要求调用方手里有内容。改名不改内容，所以 blob 原样不动，只换索引的键。
   */
  rename(fromRelative: string, toRelative: string): void {
    this.#queue = this.#queue.then(() => this.#rename(fromRelative, toRelative)).catch((err) => {
      logError('[Nexus Ledger] 搬共同祖先失败（不影响改名）:', err);
    });
  }

  /** 等已排队的写入落完。**只有测试需要** —— 生产路径一律 fire-and-forget。 */
  flush(): Promise<void> {
    return this.#queue;
  }

  async #write(relativePath: string, content: string): Promise<void> {
    const hash = hashOf(content);
    const index = this.#readIndex();
    const previous = index.entries[relativePath];

    // 内容没变（连续保存同一份）：只刷新时刻，不重复落 blob。
    if (previous?.hash === hash) {
      index.entries[relativePath] = { hash, at: Date.now() };
      await this.#writeIndex(index);
      return;
    }

    const blobsDir = path.join(this.directory, BLOBS_DIR);
    await fs.promises.mkdir(blobsDir, { recursive: true });
    await fs.promises.writeFile(path.join(blobsDir, hash), content, 'utf8');

    index.entries[relativePath] = { hash, at: Date.now() };
    await this.#writeIndex(index);

    await this.#reapBlob(previous?.hash, index);
  }

  async #forget(relativePath: string): Promise<void> {
    const index = this.#readIndex();
    const entry = index.entries[relativePath];
    if (!entry) return;

    delete index.entries[relativePath];
    await this.#writeIndex(index);
    await this.#reapBlob(entry.hash, index);
  }

  async #rename(fromRelative: string, toRelative: string): Promise<void> {
    const index = this.#readIndex();
    const entry = index.entries[fromRelative];
    if (!entry) return;

    delete index.entries[fromRelative];
    index.entries[toRelative] = entry;
    // blob 不动：改名不改内容，hash 还是那一个。
    await this.#writeIndex(index);
  }

  /** 某个 blob 已经没有任何条目引用时就删掉它。 */
  async #reapBlob(hash: string | undefined, index: LedgerIndex): Promise<void> {
    if (!hash) return;
    if (Object.values(index.entries).some((entry) => entry.hash === hash)) return;
    await fs.promises.rm(path.join(this.directory, BLOBS_DIR, hash), { force: true });
  }

  /**
   * 读索引。**不存在 / 不是 JSON / 版本对不上 / 形状不对，一律当空账本。**
   *
   * 不区分这些情况是有意的：它是缓存，区分了也没有更好的处置 —— 唯一的选择都是
   * 「当作没有祖先」。而重建索引的成本只是下次保存时重记一遍。
   */
  #readIndex(): LedgerIndex {
    try {
      const raw = fs.readFileSync(path.join(this.directory, INDEX_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<LedgerIndex>;
      if (
        parsed.version !== INDEX_VERSION ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        return { version: INDEX_VERSION, entries: {} };
      }
      return { version: INDEX_VERSION, entries: parsed.entries as Record<string, LedgerEntry> };
    } catch {
      return { version: INDEX_VERSION, entries: {} };
    }
  }

  /**
   * 写索引：**先写临时文件再改名**。
   *
   * 直接覆盖的话，中途崩了会留下半截 JSON —— 而 `#readIndex` 会把它当空账本，
   * 于是**所有**文档的祖先一起消失。改名是原子的，最坏情况是丢掉这一次写入。
   */
  async #writeIndex(index: LedgerIndex): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, INDEX_FILE);
    const temp = `${target}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(index), 'utf8');
    await fs.promises.rename(temp, target);
  }
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
