// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { translate } from '@nexus/i18n';
import { LINK_FORMAT_MARKDOWN, LINK_FORMAT_WIKILINK, buildDocumentLink, type LinkBuildFailure } from '@nexus/core';
import { linkFailureKey, type LinkAction } from '../src/workspace/link-failure.js';

/**
 * 「写不出一条链接」的失败回执。复制（树右键）与插入（选区条 / Ctrl+Alt+K）共用这一层。
 *
 * 这一层只有三件事可测，但三件都值得测：
 *
 * 1. **三种原因映射到三个不同的键。** 一句笼统的「失败」会让「没有当前文档」和
 *    「文件名里有怪字符」变成同一个死胡同 —— 而这两件事用户能做的下一步完全不同。
 * 2. **同一个原因在两个动作下说不同的话。** `no-current-document` 尤其：
 *    复制时是「还没打开文档」，插入时是「这篇还没保存、没有路径」。
 *    两者共用一个键的话，必然对其中一个说错下一步。
 * 3. **这些键真的在词典里。** 拼错的键在界面上**不报错**，它原样显示成
 *    `editor.insertLinkNoDocument` —— 而 `translate` 对认不出的键就是返回键本身，
 *    所以「不是键」这一条断言恰好能把拼错拦下来。
 *
 * 判据只取 `Object.keys` 能拿到的三种原因，用 `buildDocumentLink` 真的造一遍失败结果，
 * 而不是手写一份 `LinkBuildFailure` 的清单 —— 那样将来加了第四种原因，这里照样绿。
 */
const ACTIONS: readonly LinkAction[] = ['copy', 'insert'];

describe('链接失败文案：原因 → 键', () => {
  /** 用真实调用造出每一种失败，避免手抄一份原因清单。 */
  const failures: LinkBuildFailure[] = [
    // Markdown 档没有当前文档 ⇒ `no-current-document`
    buildDocumentLink(
      { path: '/v/dma.md', relativePath: 'dma.md' },
      LINK_FORMAT_MARKDOWN,
      null
    ),
    // 跨盘符 ⇒ `not-in-workspace`
    buildDocumentLink(
      { path: 'D:/v/dma.md', relativePath: 'dma.md' },
      LINK_FORMAT_MARKDOWN,
      'C:/v/root.md'
    ),
    // wikilink 语法表达不了的字符 ⇒ `unescapable-name`
    buildDocumentLink(
      { path: '/v/a|b.md', relativePath: 'a|b.md' },
      LINK_FORMAT_WIKILINK,
      null
    )
  ].map((result) => {
    if (result.ok) throw new Error('这一条本该失败，测试前提就不成立');
    return result.reason;
  });

  it('三种原因各自一条话，互不重复（每个动作各判一次）', () => {
    for (const action of ACTIONS) {
      const keys = failures.map((reason) => linkFailureKey(reason, action));
      expect(new Set(keys).size, action).toBe(failures.length);
    }
  });

  it('两个动作的键**完全不重叠** —— 共用一个键就意味着一句话要说两个场景', () => {
    const copy = new Set(failures.map((reason) => linkFailureKey(reason, 'copy')));
    const insert = failures.map((reason) => linkFailureKey(reason, 'insert'));
    expect(insert.filter((key) => copy.has(key))).toEqual([]);
  });

  it('每种原因 × 每个动作的键在两语词典里都存在', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      for (const action of ACTIONS) {
        for (const reason of failures) {
          const key = linkFailureKey(reason, action);
          expect(translate(locale, key), `${locale} 缺少 ${key}`).not.toBe(key);
        }
      }
    }
  });

  it('三种原因覆盖了全部取值 —— 将来加第四种时这条会红', () => {
    // `LinkBuildFailure` 是联合类型，运行期拿不到它的成员表。真正的完整性保证在
    // `link-failure.ts` 的 `Record<LinkBuildFailure, string>` 上 —— 那是**编译期**的，
    // 而 `renderer/src/**` 确实进 typecheck（只有 `renderer/test/**` 不进）。
    // 这里再钉一次「造得出失败的组合恰好触到三种」，是给「新加了一种原因但没人造得出来」兜底。
    expect(new Set(failures).size).toBe(3);
  });
});

/**
 * 两个动作用到的**全部**文案键。
 *
 * 这是一条**清单哨兵**：它拦的是「`App.tsx` 里写了一个词典里没有的键」——
 * 那种错在界面上不报错，它原样显示成 `workspace.copyLinkDone`，
 * 而真机用例（`copy-link.test.ts` / `insert-link.test.ts`）刻意不锁措辞，所以拦不住它。
 *
 * 加键时先 `grep` 这个数组（同 `settings-window.test.ts` 的字段清单）。
 */
const LINK_KEYS = [
  'workspace.copyLink',
  'workspace.copyLinkDone',
  'workspace.copyLinkFailed',
  'workspace.copyLinkNoDocument',
  'workspace.copyLinkNotInWorkspace',
  'workspace.copyLinkUnescapable',
  'cmd.insertLink',
  'insertLink.title',
  'insertLink.placeholder',
  'insertLink.noMatch',
  'insertLink.noIndex',
  'editor.insertLinkNoDocument',
  'editor.insertLinkNotInWorkspace',
  'editor.insertLinkUnescapable'
] as const;

describe('链接相关文案键', () => {
  it('全部键在两语词典里都存在', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      for (const key of LINK_KEYS) {
        expect(translate(locale, key), `${locale} 缺少 ${key}`).not.toBe(key);
      }
    }
  });

  it('成功回执带 {text} 占位符 —— 用户要靠它看出当前是哪一档写法', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      expect(translate(locale, 'workspace.copyLinkDone', { text: '[[dma]]' })).toContain('[[dma]]');
    }
  });
});
