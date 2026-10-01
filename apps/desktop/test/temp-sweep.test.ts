import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, sweepStaleTempDirs, TEMP_DIR_PREFIX } from './smoke-harness';

/**
 * `sweepStaleTempDirs` 的双向哨兵。
 *
 * 存在的理由：harness 的退出钩子只覆盖**正常退出**，被强杀的批跑会把临时目录留在
 * `%TEMP%` 里（实测攒到过 275 个 / 54.7 MB）。清扫是「删东西」，所以它必须**两个方向**
 * 都被钉住：够旧的删掉（否则等于没修），新鲜的与不匹配前缀的一律不动 —— 后者不是洁癖，
 * 并行跑的其他测试文件手里的目录就在同一个 `%TEMP%` 里，删错的症状是随机失败。
 *
 * 不启动 Electron，也不需要 happy-dom。
 */
const HOUR_MS = 60 * 60 * 1000;

/** 本用例自己造出来的条目，跑完一并收掉（清扫没删掉的由它兜底）。 */
const created: string[] = [];

/** 造一个带指定年龄的条目。年龄靠 `utimesSync` 写 mtime，因为清扫判的就是它。 */
function makeDir(prefix: string, ageMs: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

afterEach(() => {
  for (const entry of created.splice(0)) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
});

describe('测试临时目录 · 陈旧清扫', () => {
  it('删掉超过 24 小时的 nexus-* 残留', () => {
    const stale = makeDir(`${TEMP_DIR_PREFIX}sweep-stale-`, 48 * HOUR_MS);
    sweepStaleTempDirs();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('不动新鲜的 nexus-* 目录', () => {
    const fresh = makeDir(`${TEMP_DIR_PREFIX}sweep-fresh-`, 0);
    sweepStaleTempDirs();
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('不动前缀不匹配的目录', () => {
    const other = makeDir('other-sweep-', 48 * HOUR_MS);
    sweepStaleTempDirs();
    expect(fs.existsSync(other)).toBe(true);
  });

  it('不动同前缀的文件', () => {
    const file = path.join(os.tmpdir(), `${TEMP_DIR_PREFIX}sweep-file-${process.pid}`);
    fs.writeFileSync(file, 'x');
    created.push(file);
    const when = new Date(Date.now() - 48 * HOUR_MS);
    fs.utimesSync(file, when, when);
    sweepStaleTempDirs();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('createTempDir 拒绝不在清扫范围内的前缀', () => {
    expect(() => createTempDir('scratch-')).toThrow(/nexus-/);
  });
});
