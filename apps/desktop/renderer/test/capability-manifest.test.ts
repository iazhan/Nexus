import { describe, expect, it } from 'vitest';
import { MATH_EXTENSION_ID, MERMAID_EXTENSION_ID } from '@nexus/editor';
import { VIEWER_DOCUMENT_TYPES } from '@nexus/core';
import { hasMessage } from '@nexus/i18n';
import { buildCapabilityManifest } from '../src/workspace/capability-manifest.js';

/**
 * 能力清单投影。
 *
 * 它要守住的第一条不变量是**报数正确**：面板显示的条数必须等于注册表里真实存在的能力数。
 * 此前只有 `ExtensionHost` 有 UI，于是面板显示「2」而实际有 5 个能力 —— 那不是少了功能，
 * 是**谎报了现状**。
 *
 * 第二条是**状态可区分**。只断言「`idle` 出现了」是不够的：把 `failed` 也画成 `idle`
 * 同样能过。所以这里逐档断言五个状态，并单独钉住 `failed` 与 `disabled` 的优先级 ——
 * 那是唯一一处「两种写法都能过测试、但只有一种是对的」的地方。
 */

/** 一份从没被触发过、也没被关掉的渲染器状态。 */
const IDLE_RENDERER = { requested: false, loaded: false, failed: false, disabled: false };

/** 用**真实**的类型清单与 id 常量搭出「出厂状态」的两个注册表。 */
const BUILTIN_HOST = {
  listExtensions: () => [
    { id: MATH_EXTENSION_ID, state: 'idle' as const },
    { id: MERMAID_EXTENSION_ID, state: 'idle' as const }
  ]
};

const BUILTIN_VIEWERS = {
  listRenderers: () => VIEWER_DOCUMENT_TYPES.map((type) => ({ type, ...IDLE_RENDERER }))
};

/** 单独把一个渲染器喂进清单，取出它被算成的状态。 */
function statusOf(state: {
  requested: boolean;
  loaded: boolean;
  failed: boolean;
  disabled?: boolean;
}): string {
  return buildCapabilityManifest(undefined, {
    listRenderers: () => [{ type: 'image', ...state }]
  })[0].status;
}

describe('buildCapabilityManifest', () => {
  it('汇总两个注册表：编辑器扩展在前、渲染器在后', () => {
    const entries = buildCapabilityManifest(BUILTIN_HOST, BUILTIN_VIEWERS);

    // 顺序稳定，列表不会每次重排
    expect(entries.map((entry) => entry.id)).toEqual([
      MATH_EXTENSION_ID,
      MERMAID_EXTENSION_ID,
      ...VIEWER_DOCUMENT_TYPES
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'editor-extension',
      'editor-extension',
      'viewer',
      'viewer',
      'viewer'
    ]);
  });

  it('每条都有可读名称，不显示裸 id', () => {
    const entries = buildCapabilityManifest(BUILTIN_HOST, BUILTIN_VIEWERS);

    // 这一条同时是**穷尽性守卫**：`VIEWER_DOCUMENT_TYPES` 新增一个类型、或某个扩展 id
    // 常量改了值，`LABEL_KEYS` 就查不到 → labelKey 回落成裸 id → 这里变红。
    // 断言的是「不等于 id」而不是逐个比对文案，这样换语言、改文案都不会误伤。
    for (const entry of entries) {
      expect(entry.labelKey).not.toBe(entry.id);
    }
  });

  it('清单里出现的每个文案键，两种语言下都有译文', () => {
    const entries = buildCapabilityManifest(BUILTIN_HOST, BUILTIN_VIEWERS);

    for (const entry of entries) {
      expect(hasMessage('en-US', entry.labelKey)).toBe(true);
      expect(hasMessage('zh-CN', entry.labelKey)).toBe(true);
    }
    // 状态文案与清单共用一套词表，同样两本字典都要有
    for (const state of ['idle', 'loading', 'loaded', 'failed', 'disabled']) {
      expect(hasMessage('en-US', `plugins.state.${state}`)).toBe(true);
      expect(hasMessage('zh-CN', `plugins.state.${state}`)).toBe(true);
    }
  });

  it('认不出的 id 回落成裸 id，而不是从清单里消失', () => {
    const entries = buildCapabilityManifest(
      {
        listExtensions: () => [
          { id: MATH_EXTENSION_ID, state: 'idle' as const },
          { id: 'nexus-unknown', state: 'idle' as const }
        ]
      },
      undefined
    );

    // 静默消失比一个丑名字糟得多：新加能力却忘了登记名字时，用户至少能看到它存在
    expect(entries.map((entry) => entry.id)).toEqual([MATH_EXTENSION_ID, 'nexus-unknown']);
    expect(entries[1].labelKey).toBe('nexus-unknown');
  });

  it('五个状态两两可区分', () => {
    expect([
      statusOf(IDLE_RENDERER),
      statusOf({ requested: true, loaded: false, failed: false }),
      statusOf({ requested: true, loaded: true, failed: false }),
      statusOf({ requested: true, loaded: false, failed: true }),
      statusOf({ ...IDLE_RENDERER, disabled: true })
    ]).toEqual(['idle', 'loading', 'loaded', 'failed', 'disabled']);
  });

  it('失败的渲染器是 failed —— 不是 loading，也不是 loaded', () => {
    // 失败之后 `requested` 仍是 true（那个 chunk 确实开始下载了）。
    // 若把 failed 放在 requested 后面判，第一条会显示成「加载中」—— 一个永远转不完的圈。
    expect(statusOf({ requested: true, loaded: false, failed: true })).toBe('failed');
    expect(statusOf({ requested: true, loaded: true, failed: true })).toBe('failed');
  });

  it('被关掉的渲染器是 disabled —— 哪怕它的包已经在内存里', () => {
    // 关掉之后 `import()` 收不回来，`loaded` 会一直是 true。显示「已加载」是在说一件
    // 不会发生的事（它永远不会被用来渲染），所以 disabled 必须排在最前判。
    expect(statusOf({ requested: true, loaded: true, failed: false, disabled: true })).toBe(
      'disabled'
    );
    // 失败之后又被关掉：用户的选择解释了「为什么什么都没渲染」，比失败更该被看见
    expect(statusOf({ requested: true, loaded: false, failed: true, disabled: true })).toBe(
      'disabled'
    );
  });

  it('缺一个注册表只少一半，不整块消失', () => {
    expect(buildCapabilityManifest(BUILTIN_HOST, undefined)).toHaveLength(2);
    expect(buildCapabilityManifest(undefined, BUILTIN_VIEWERS)).toHaveLength(3);
    // 两个都没有（轻量模式）时返回空清单，而不是抛错 —— 这是只读展示，不该连累整块面板
    expect(buildCapabilityManifest(undefined, undefined)).toEqual([]);
  });
});
