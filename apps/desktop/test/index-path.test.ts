// @vitest-environment node

/**
 * 索引库落点（`electron/index-path.ts`）。
 *
 * 这个模块从 `electron/index.ts` 里抽出来的唯一理由就是**能这样测**：它是纯函数
 * （两个字符串进、一个字符串出），原来埋在会 `import electron` 的模块里，于是
 * 「同一个工作区算出的路径是否稳定」「两个工作区会不会撞名」这两件事只有真机跑得出来。
 *
 * 判据里最重要的一条是 `indexDirectoryForWorkspace` **等于** `indexPathForWorkspace`
 * 的父目录 —— 设置页的两半（显示的位置、打开的位置）正是靠这一条不分家。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INDEX_DIR_NAME,
  LEDGER_DIR_NAME,
  indexDirectoryForWorkspace,
  indexPathForWorkspace,
  ledgerDirectoryForWorkspace,
  workspaceKey
} from '../electron/index-path.js';

const USER_DATA = path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'Nexus');
const ROOT = path.join('E:', 'notes');

/**
 * 规范化键本身。它必须与 `FileService.toPathKey` 同一口径 —— 两处不一致的话，
 * 索引路径的归一就成了第三套规则。
 */
describe('工作区路径键', () => {
  it('先 resolve，再按平台决定折不折大小写', () => {
    const raw = path.join('E:', 'Notes', '..', 'Notes');
    const resolved = path.resolve(raw);

    expect(workspaceKey(raw)).toBe(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
    // 相对路径也要被 resolve 掉，否则 `./vault` 与 `<cwd>/vault` 会各建一个库。
    expect(workspaceKey('vault')).toBe(
      process.platform === 'win32'
        ? path.resolve('vault').toLowerCase()
        : path.resolve('vault')
    );
  });
});

describe('索引库路径', () => {
  it('落在 userData 下的 workspace-index 目录里，文件名是 16 位十六进制加 .db', () => {
    const filePath = indexPathForWorkspace(USER_DATA, ROOT);

    expect(filePath.startsWith(USER_DATA)).toBe(true);
    expect(path.dirname(filePath)).toBe(path.join(USER_DATA, INDEX_DIR_NAME));
    expect(path.basename(filePath)).toMatch(/^[0-9a-f]{16}\.db$/);
  });

  it('同一个工作区算两次得到同一个路径 —— 重开工作区要复用同一个库', () => {
    expect(indexPathForWorkspace(USER_DATA, ROOT)).toBe(indexPathForWorkspace(USER_DATA, ROOT));
  });

  /**
   * 哈希存在的意义就是这一条。退化成「文件名 = 工作区名」时，两个同名工作区
   * （`E:/notes` 与 `D:/notes`）会共用同一个库，表现是搜出另一个目录里的文档。
   */
  it('不同工作区算出不同文件 —— 同名不同盘也不例外', () => {
    expect(indexPathForWorkspace(USER_DATA, path.join('E:', 'notes'))).not.toBe(
      indexPathForWorkspace(USER_DATA, path.join('D:', 'notes'))
    );
  });

  /**
   * **这一条是真机用例查出来的 bug 的哨兵**（第十批）。
   *
   * 同一个工作区在应用里有不止一种写法：侧栏预热用启动参数里的原始路径，设置页的动作用
   * `getWorkspaceRoots()[0]`（`FileService.toPathKey` 的产物，Windows 上折成小写）。
   * 归一之前这两条字符串各哈希出一个文件名 —— **一个工作区两个库**，而且两边都不报错，
   * 症状只是「在设置页重建了索引，搜索结果没变」。
   */
  it('同一个目录的不同写法归一到同一个库 —— 大小写与结尾分隔符都不该分家', () => {
    const canonical = indexPathForWorkspace(USER_DATA, path.join('E:', 'notes'));

    expect(indexPathForWorkspace(USER_DATA, path.join('e:', 'notes'))).toBe(canonical);
    expect(indexPathForWorkspace(USER_DATA, `${path.join('E:', 'notes')}${path.sep}`)).toBe(
      canonical
    );
    expect(indexPathForWorkspace(USER_DATA, path.join('E:', 'notes', '..', 'notes'))).toBe(
      canonical
    );
  });

  /**
   * 归一必须**只吃掉写法差异**，不能吃掉真实的区分度：两个不同目录仍然要两个库。
   * 少了这一条，把 `workspaceKey` 写成「恒返回同一个常量」也能让上面那条通过。
   */
  it('归一之后不同目录仍然不同 —— 归一只折叠大小写，不折叠目录名', () => {
    expect(indexPathForWorkspace(USER_DATA, path.join('E:', 'notes'))).not.toBe(
      indexPathForWorkspace(USER_DATA, path.join('E:', 'notes2'))
    );
  });

  it('换一个 userData 目录，文件名不变、只有前缀跟着换', () => {
    const a = indexPathForWorkspace(path.join('C:', 'ud1'), ROOT);
    const b = indexPathForWorkspace(path.join('D:', 'ud2'), ROOT);

    expect(path.basename(a)).toBe(path.basename(b));
    expect(a).not.toBe(b);
  });

  /**
   * 设置页那一项的两半靠这一条绑在一起：只读值显示 `indexPathForWorkspace`，
   * 「打开索引目录」打开 `indexDirectoryForWorkspace`。两者分家时，用户看到的路径
   * 与他点开的那一层会不一致，而**两处都不报错**。
   */
  it('目录就是文件的父目录，且是 userData 下那一层', () => {
    const dir = indexDirectoryForWorkspace(USER_DATA, ROOT);

    expect(dir).toBe(path.dirname(indexPathForWorkspace(USER_DATA, ROOT)));
    expect(dir).toBe(path.join(USER_DATA, INDEX_DIR_NAME));
  });
});

describe('账本目录', () => {
  it('落在 userData 下的 concord-ledger 里，按工作区摘要分目录', () => {
    const dir = ledgerDirectoryForWorkspace(USER_DATA, ROOT);

    expect(path.dirname(dir)).toBe(path.join(USER_DATA, LEDGER_DIR_NAME));
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * 「保存时写进哪个账本」与「合并时读哪个账本」不分家的判据。两者各写一套归一的话，
   * 症状是「明明刚保存过，合并却说没有共同祖先」，而两边都不报错。
   */
  it('与索引库共用同一套归一 —— 同一个工作区的不同写法落到同一个账本', () => {
    const trailingSlash = `${ROOT}${path.sep}`;
    expect(ledgerDirectoryForWorkspace(USER_DATA, trailingSlash)).toBe(
      ledgerDirectoryForWorkspace(USER_DATA, ROOT)
    );

    if (process.platform === 'win32') {
      expect(ledgerDirectoryForWorkspace(USER_DATA, ROOT.toUpperCase())).toBe(
        ledgerDirectoryForWorkspace(USER_DATA, ROOT)
      );
    }
  });

  it('不同工作区落到不同目录，且不与索引库共目录', () => {
    const a = ledgerDirectoryForWorkspace(USER_DATA, ROOT);
    const b = ledgerDirectoryForWorkspace(USER_DATA, path.join('E:', 'other'));

    expect(a).not.toBe(b);
    expect(path.dirname(a)).not.toBe(indexDirectoryForWorkspace(USER_DATA, ROOT));
  });
});
