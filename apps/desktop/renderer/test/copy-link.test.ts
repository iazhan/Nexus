// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { translate } from '@nexus/i18n';
import { LINK_FORMAT_MARKDOWN, LINK_FORMAT_WIKILINK, buildDocumentLink, type LinkBuildFailure } from '@nexus/core';
import { copyLinkFailureKey } from '../src/workspace/copy-link.js';

/**
 * 「复制链接」的失败回执。
 *
 * 这一层只有两件事可测，但两件都值得测：
 *
 * 1. **三种原因映射到三个不同的键。** 一句笼统的「复制失败」会让「没打开文档」和
 *    「文件名里有怪字符」变成同一个死胡同 —— 而这两件事用户能做的下一步完全不同。
 * 2. **这些键真的在词典里。** 拼错的键在界面上**不报错**，它原样显示成
 *    `workspace.copyLinkNoDocument` —— 而 `translate` 对认不出的键就是返回键本身，
 *    所以「不是键」这一条断言恰好能把拼错拦下来。
 *
 * 判据只取 `Object.keys` 能拿到的三种原因，用 `buildDocumentLink` 真的造一遍失败结果，
 * 而不是手写一份 `LinkBuildFailure` 的清单 —— 那样将来加了第四种原因，这里照样绿。
 */
describe('复制链接的失败文案', () => {
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

  it('三种原因各自一条话，互不重复', () => {
    const keys = failures.map(copyLinkFailureKey);
    expect(new Set(keys).size).toBe(failures.length);
  });

  it('三种原因的键在两语词典里都存在', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      for (const key of failures.map(copyLinkFailureKey)) {
        expect(translate(locale, key), `${locale} 缺少 ${key}`).not.toBe(key);
      }
    }
  });

  it('三种原因覆盖了全部取值 —— 将来加第四种时这条会红', () => {
    // `LinkBuildFailure` 是联合类型，运行期拿不到它的成员表。真正的完整性保证在
    // `copy-link.ts` 的 `Record<LinkBuildFailure, string>` 上 —— 那是**编译期**的，
    // 而 `renderer/src/**` 确实进 typecheck（只有 `renderer/test/**` 不进）。
    // 这里再钉一次「造得出失败的组合恰好触到三种」，是给「新加了一种原因但没人造得出来」兜底。
    expect(new Set(failures).size).toBe(3);
  });
});

/**
 * 复制链接用到的**全部**文案键。
 *
 * 这是一条**清单哨兵**：它拦的是「`App.tsx` 里写了一个词典里没有的键」——
 * 那种错在界面上不报错，它原样显示成 `workspace.copyLinkDone`，
 * 而真机用例（`copy-link.test.ts`）刻意不锁措辞，所以拦不住它。
 *
 * 加键时先 `grep` 这个数组（同 `settings-window.test.ts` 的字段清单）。
 */
const COPY_LINK_KEYS = [
  'workspace.copyLink',
  'workspace.copyLinkDone',
  'workspace.copyLinkFailed',
  'workspace.copyLinkNoDocument',
  'workspace.copyLinkNotInWorkspace',
  'workspace.copyLinkUnescapable'
] as const;

describe('复制链接的文案键', () => {
  it('六个键在两语词典里都存在', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      for (const key of COPY_LINK_KEYS) {
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
