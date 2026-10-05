// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangelogEntry, ChangelogRelease, UpdateState } from '../../ipc/channels.js';
import { UPDATE_REMIND_INTERVAL_MS } from '../../ipc/channels.js';
import { localeManager } from '../src/platform.js';
import { readWindowRole } from '../src/window-role.js';
import { UpdateNoticeBar } from '../src/update/UpdateNoticeBar.js';
import { UpdateView } from '../src/update/UpdateView.js';
import { UpdateWindow } from '../src/update/UpdateWindow.js';
import { useUpdateNotice } from '../src/update/use-update-state.js';

/**
 * 更新界面：主窗口的提示条 + 更新窗口本体 + 窗口外壳。
 *
 * 三件事只有这一层能便宜地验：
 *
 * 1. **提示条的显示判据**。它有五条（阶段、跳过、稍后、版本相等、现算时刻），
 *    而真机上要凑齐这些状态得先有一次真下载 —— 组件层可以直接喂。
 * 2. **提示条的性能判据**。下载进度每秒变好几次，而提示条的文案一个字都没变；
 *    全量订阅会让整个主窗口重渲染几百次。这里用一个渲染计数器钉住它。
 * 3. **更新视图的分支**：阶段文案、进度条、按钮显隐、日志的四种状态、双语回落、
 *    类型徽章「有译文才画」、来源徽章。
 *
 * 真机那一层（窗口真的建出来、单例、`app.getVersion()` 走通、Escape 关窗）在
 * `apps/desktop/test/update-window.test.ts`；状态机在 `test/updater.test.ts`；
 * 三层回落与合并规则在 `test/changelog.test.ts`。
 *
 * 注意 `renderer/test/**` 不进 typecheck，类型只靠 esbuild 转译。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { name: string; args: unknown[] }[];
/** 广播的入口。`UpdateNoticeBar` / `UpdateView` 挂上订阅后由它推状态。 */
let pushState: ((state: UpdateState) => void) | null;
/** `getUpdateState()` 答的那份快照。 */
let snapshot: UpdateState | null;
/** `getChangelog()` 答的东西。`undefined` 表示「还没想好」，用例会显式设。 */
let changelogAnswer: unknown;
let installResult: boolean;

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'idle',
    current: '0.73.0',
    latest: null,
    skipped: null,
    remindAfter: null,
    progress: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    error: null,
    ...overrides
  };
}

function release(
  version: string,
  entries: ChangelogEntry[],
  source: ChangelogRelease['source'] = 'bundled'
): ChangelogRelease {
  return { version, date: null, entries, source };
}

function entry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return { type: null, scope: null, zh: '改了点什么', en: null, ...overrides };
}

function stubBridge(): void {
  calls = [];
  pushState = null;
  snapshot = null;
  changelogAnswer = null;
  installResult = true;

  (window as unknown as { nexus: unknown }).nexus = {
    getUpdateState: () => Promise.resolve(snapshot),
    onUpdateStateChanged: (callback: (next: UpdateState) => void) => {
      pushState = callback;
      return () => {
        pushState = null;
      };
    },
    openUpdateWindow: () => {
      calls.push({ name: 'openUpdateWindow', args: [] });
    },
    skipUpdateVersion: (version: string) => {
      calls.push({ name: 'skipUpdateVersion', args: [version] });
      return Promise.resolve(snapshot);
    },
    remindUpdateLater: () => {
      calls.push({ name: 'remindUpdateLater', args: [] });
      return Promise.resolve(snapshot);
    },
    installUpdateNow: () => {
      calls.push({ name: 'installUpdateNow', args: [] });
      return Promise.resolve(installResult);
    },
    getChangelog: () => Promise.resolve(changelogAnswer),
    openExternal: (url: string) => {
      calls.push({ name: 'openExternal', args: [url] });
      return Promise.resolve(true);
    },
    closeWindow: () => {
      calls.push({ name: 'closeWindow', args: [] });
    },
    minimizeWindow: () => {
      calls.push({ name: 'minimizeWindow', args: [] });
    },
    maximizeWindow: () => {
      calls.push({ name: 'maximizeWindow', args: [] });
    },
    getWindowState: () => Promise.resolve({ maximized: false }),
    onWindowStateChanged: () => () => {}
  };
}

/** 渲染 + 把 effect 里那几条 promise（快照、更新日志）冲干净。 */
async function render(element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

/**
 * 拆掉重挂再渲染。
 *
 * 同一个 `root` 上二次 `render` **不会重跑 effect**（依赖数组是空的），于是新给的
 * `snapshot` 根本读不到 —— 钩子还停在上一份状态。要验「换一份快照会画成什么样」，
 * 必须真的重挂。
 */
async function remount(element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await render(element);
}

/** 从主进程推一份新状态。 */
async function emit(next: UpdateState): Promise<void> {
  await act(async () => {
    pushState?.(next);
  });
}

function text(selector: string): string {
  return (container.querySelector(selector)?.textContent ?? '').trim();
}

function pressEscape(preventDefault = false): void {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (preventDefault) event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeEach(() => {
  localeManager.setLocale('zh-CN');
  stubBridge();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { nexus?: unknown }).nexus;
});

describe('窗口角色', () => {
  it('带 ?window=update 的查询串判为更新窗口', () => {
    expect(readWindowRole('?window=update')).toBe('update');
  });

  /** 四个角色互不误配 —— 认错一个就会把更新界面画进主窗口。 */
  it('四个角色各归各的', () => {
    expect(readWindowRole('?window=main')).toBe('main');
    expect(readWindowRole('?window=settings')).toBe('settings');
    expect(readWindowRole('?window=theme')).toBe('theme');
    expect(readWindowRole('?window=update')).toBe('update');
  });

  /** 认不出的值一律当主窗口：宁可多开一个主界面，也不要因为一个拼错的参数把人丢进空窗。 */
  it('认不出的取值回落成主窗口', () => {
    expect(readWindowRole('?window=updates')).toBe('main');
    expect(readWindowRole('')).toBe('main');
  });
});

describe('主窗口提示条：什么时候该出现', () => {
  it('没有更新时不画 —— 五个非「有更新」的阶段都不该占位置', async () => {
    for (const phase of ['unsupported', 'idle', 'checking', 'up-to-date', 'error'] as const) {
      snapshot = state({ phase, latest: phase === 'up-to-date' ? '0.73.0' : null });
      await remount(<UpdateNoticeBar />);
      expect(container.querySelector('[data-update-notice]'), `阶段 ${phase}`).toBeNull();
    }
  });

  it('发现新版本 → 出现，且文案带版本号', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    await remount(<UpdateNoticeBar />);

    expect(container.querySelector('[data-update-notice]')).not.toBeNull();
    expect(text('.nexus-update-notice-text')).toContain('0.74.0');
  });

  it('下载中与已下载也画 —— 提示条不显示进度，但「有更新」这个事实要一直在', async () => {
    for (const phase of ['downloading', 'downloaded'] as const) {
      snapshot = state({ phase, latest: '0.74.0' });
      await remount(<UpdateNoticeBar />);
      expect(container.querySelector('[data-update-notice]'), `阶段 ${phase}`).not.toBeNull();
    }
  });

  it('「已就绪」与「发现新版本」是两句不同的话', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    await remount(<UpdateNoticeBar />);
    const availableText = text('.nexus-update-notice-text');

    snapshot = state({ phase: 'downloaded', latest: '0.74.0' });
    await remount(<UpdateNoticeBar />);
    const downloadedText = text('.nexus-update-notice-text');

    expect(downloadedText).not.toBe(availableText);
    // 「已就绪」那句不带版本号 —— 带的是「重启即可安装」这个动作。
    expect(downloadedText).not.toContain('0.74.0');
  });

  it('跳过的正是当前这个版本 → 不画', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0', skipped: '0.74.0' });
    await remount(<UpdateNoticeBar />);

    expect(container.querySelector('[data-update-notice]')).toBeNull();
  });

  it('跳过的是**别的**版本 → 照画 —— 他表达的是「那一版我不要」', async () => {
    snapshot = state({ phase: 'available', latest: '0.75.0', skipped: '0.74.0' });
    await remount(<UpdateNoticeBar />);

    expect(container.querySelector('[data-update-notice]')).not.toBeNull();
  });

  it('在「稍后提醒」的期限内不画', async () => {
    snapshot = state({
      phase: 'available',
      latest: '0.74.0',
      remindAfter: Date.now() + UPDATE_REMIND_INTERVAL_MS
    });
    await remount(<UpdateNoticeBar />);

    expect(container.querySelector('[data-update-notice]')).toBeNull();
  });

  it('稍后期满后自己恢复 —— 判据是现算的时刻，没有任何定时器在改标记', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0', remindAfter: Date.now() - 1 });
    await remount(<UpdateNoticeBar />);

    expect(container.querySelector('[data-update-notice]')).not.toBeNull();
  });

  it('点按钮打开更新窗口', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    await remount(<UpdateNoticeBar />);

    await act(async () => {
      (container.querySelector('.nexus-update-notice-action') as HTMLButtonElement).click();
    });

    expect(calls.map((call) => call.name)).toEqual(['openUpdateWindow']);
  });

  /**
   * 下载进度每秒变好几次，而提示条的文案一个字都没变。`useUpdateNotice` 的判据是
   * **签名字符串没变就不 setState** —— 一个几十 MB 的安装包会发几百次进度事件，
   * 每次都重渲染的话，跟着一起重绘的是**整个主窗口**。
   *
   * 探针必须**自己调那个钩子**：只有持有 state 的组件才会被重渲染，
   * 把 `<UpdateNoticeBar />` 当子组件包一层是数不到的（子组件 setState 不会重渲染父组件）。
   */
  it('进度 / 速度 / 字节数变化时不重渲染', async () => {
    let renders = 0;
    const Probe: React.FC = () => {
      renders += 1;
      return <span>{useUpdateNotice()?.phase ?? ''}</span>;
    };

    snapshot = state({ phase: 'downloading', latest: '0.74.0', progress: 0.1 });
    await remount(<Probe />);
    const baseline = renders;

    await emit(state({ phase: 'downloading', latest: '0.74.0', progress: 0.9, bytesPerSecond: 999 }));
    await emit(state({ phase: 'downloading', latest: '0.74.0', progress: 0.99, transferred: 1, total: 2 }));

    expect(renders).toBe(baseline);
  });

  it('但阶段真的变了就要重渲染', async () => {
    let renders = 0;
    const Probe: React.FC = () => {
      renders += 1;
      return <span>{useUpdateNotice()?.phase ?? ''}</span>;
    };

    snapshot = state({ phase: 'downloading', latest: '0.74.0', progress: 0.1 });
    await remount(<Probe />);
    const baseline = renders;

    await emit(state({ phase: 'downloaded', latest: '0.74.0', progress: 1 }));

    expect(renders).toBeGreaterThan(baseline);
  });

  it('初始快照晚于广播到达时不回退 —— 旧值覆盖会让提示条退回上一阶段', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    await remount(<UpdateNoticeBar />);

    // 广播先把阶段推到 downloaded，随后 `getUpdateState` 那份**更旧**的快照才回来。
    await emit(state({ phase: 'downloaded', latest: '0.74.0' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(text('.nexus-update-notice-text')).not.toContain('0.74.0');
  });
});

describe('更新窗口本体：阶段与动作', () => {
  it('未打包：说明没有更新通道，且「检查更新」按不动', async () => {
    snapshot = state({ phase: 'unsupported' });
    changelogAnswer = [];
    await render(<UpdateView />);

    expect(container.querySelector('[data-update-phase]')?.getAttribute('data-update-phase')).toBe(
      'unsupported'
    );
    expect(text('[data-update-status]')).not.toBe('');
    expect(
      (container.querySelector('.nexus-update-button-primary') as HTMLButtonElement).disabled
    ).toBe(true);
    // 没有更新可装 → 不画「稍后 / 跳过」。
    expect(container.querySelectorAll('.nexus-update-actions button')).toHaveLength(1);
  });

  it('有更新：多一行最新版本号，并给出「稍后 / 跳过」', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    changelogAnswer = [];
    await render(<UpdateView />);

    expect(text('[data-latest-version]')).toBe('0.74.0');
    expect(text('[data-current-version]')).toBe('0.73.0');
    expect(container.querySelectorAll('.nexus-update-actions button')).toHaveLength(3);
  });

  it('下载中：画出进度条，「检查更新」按不动', async () => {
    snapshot = state({ phase: 'downloading', latest: '0.74.0', progress: 0.425 });
    changelogAnswer = [];
    await render(<UpdateView />);

    const bar = container.querySelector('.nexus-update-progress');
    expect(bar?.getAttribute('role')).toBe('progressbar');
    expect(bar?.getAttribute('aria-valuenow')).toBe('43');
    expect(
      (container.querySelector('.nexus-update-button-primary') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('下载完：主按钮变成「立即重启」', async () => {
    snapshot = state({ phase: 'downloaded', latest: '0.74.0', progress: 1 });
    changelogAnswer = [];
    await render(<UpdateView />);

    const primary = container.querySelector('.nexus-update-button-primary') as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    expect(primary.textContent?.trim()).not.toBe('');

    // 「立即重启」这一格点下去真的走桥上，而且走的是安装那条通道（不是再检查一次）。
    await act(async () => primary.click());
    expect(calls.map((call) => call.name)).toEqual(['installUpdateNow']);
  });

  it('有未保存文档时拒绝重启，并说明原因 —— `false` 是正常路径不是异常', async () => {
    snapshot = state({ phase: 'downloaded', latest: '0.74.0', progress: 1 });
    changelogAnswer = [];
    installResult = false;
    await render(<UpdateView />);

    await act(async () => {
      (container.querySelector('.nexus-update-button-primary') as HTMLButtonElement).click();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect((alert?.textContent ?? '').trim()).not.toBe('');
  });

  it('点「跳过」传的是**界面上显示的那个** latest，而不是主进程的当前值', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    changelogAnswer = [];
    await render(<UpdateView />);

    // 动作排的顺序是「稍后 / 跳过 / 主按钮」—— 次要动作在前，主按钮在最右。
    const buttons = container.querySelectorAll<HTMLButtonElement>('.nexus-update-actions button');
    await act(async () => buttons[1]?.click());

    expect(calls).toEqual([{ name: 'skipUpdateVersion', args: ['0.74.0'] }]);
  });

  it('点「稍后」走稍后那条通道', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    changelogAnswer = [];
    await render(<UpdateView />);

    const buttons = container.querySelectorAll<HTMLButtonElement>('.nexus-update-actions button');
    await act(async () => buttons[0]?.click());

    expect(calls.map((call) => call.name)).toEqual(['remindUpdateLater']);
  });

  it('「稍后 / 跳过」在没有更新时不出现 —— 那两个动作的前提是有个版本可以选', async () => {
    snapshot = state({ phase: 'up-to-date', latest: '0.73.0' });
    changelogAnswer = [];
    await render(<UpdateView />);

    expect(container.querySelectorAll('.nexus-update-actions button')).toHaveLength(1);
  });

  /**
   * 状态点的色调跟着阶段走。只断言文字的话，「有新版本」与「已是最新」画成同一个颜色
   * 也能过 —— 而这两个状态的下一步动作完全不同（一个要点开看，一个什么都不用做）。
   */
  it('状态卡片的色调跟着阶段走', async () => {
    snapshot = state({ phase: 'up-to-date' });
    changelogAnswer = [];
    await render(<UpdateView />);
    expect(container.querySelector('.nexus-update-summary')?.getAttribute('data-tone')).toBe(
      'success'
    );

    snapshot = state({ phase: 'downloaded', latest: '0.74.0', progress: 1 });
    await remount(<UpdateView />);
    expect(container.querySelector('.nexus-update-summary')?.getAttribute('data-tone')).toBe(
      'accent'
    );
  });

  /**
   * DOM 顺序就是视觉顺序：次要动作在前、主按钮最后（整排右对齐）。
   * 靠 CSS `order` 把主按钮推到最右是能少改两个用例，但那样 Tab 会从最右边跳回最左边。
   */
  it('主按钮在 DOM 里排最后 —— 焦点顺序跟着视觉顺序走', async () => {
    snapshot = state({ phase: 'available', latest: '0.74.0' });
    changelogAnswer = [];
    await render(<UpdateView />);

    const buttons = Array.from(container.querySelectorAll('.nexus-update-actions button'));
    expect(buttons[buttons.length - 1]?.classList.contains('nexus-update-button-primary')).toBe(
      true
    );
  });
});

describe('更新窗口本体：更新日志', () => {
  it('拿不到日志时给一句人话 + 一个去 GitHub 的出口', async () => {
    snapshot = state();
    changelogAnswer = null;
    await render(<UpdateView />);

    expect(container.querySelector('.nexus-update-changelog')?.getAttribute('data-changelog-state')).toBe(
      'unavailable'
    );
    const link = container.querySelector('.nexus-update-link') as HTMLButtonElement;
    expect(link).not.toBeNull();

    await act(async () => link.click());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('openExternal');
    expect(String(calls[0]?.args[0])).toContain('github.com');
  });

  it('拿到了但没有更新的版本 → 与「拿不到」是两句不同的话', async () => {
    snapshot = state();
    changelogAnswer = [release('0.70.0', [entry()])];
    await render(<UpdateView />);

    expect(container.querySelector('.nexus-update-changelog')?.getAttribute('data-changelog-state')).toBe(
      'ready'
    );
    expect(container.querySelectorAll('[data-release]')).toHaveLength(0);
    expect(container.querySelector('.nexus-update-link')).toBeNull();
  });

  it('默认只画比当前版本**新**的那些', async () => {
    snapshot = state();
    changelogAnswer = [
      release('0.75.0', [entry()]),
      release('0.73.0', [entry()]),
      release('0.70.0', [entry()])
    ];
    await render(<UpdateView />);

    expect(
      Array.from(container.querySelectorAll('[data-release]')).map((el) =>
        el.getAttribute('data-release')
      )
    ).toEqual(['0.75.0']);
  });

  it('勾上「显示全部历史版本」就都画出来，取消勾选再收回去', async () => {
    snapshot = state();
    changelogAnswer = [release('0.75.0', [entry()]), release('0.70.0', [entry()])];
    await render(<UpdateView />);

    const toggle = container.querySelector(
      '.nexus-update-show-all input'
    ) as HTMLInputElement;

    await act(async () => toggle.click());
    expect(container.querySelectorAll('[data-release]')).toHaveLength(2);

    await act(async () => toggle.click());
    expect(container.querySelectorAll('[data-release]')).toHaveLength(1);
  });

  it('比当前版本新不靠字符串比 —— 0.10.0 在字符串序里小于 0.9.0，而它实际更新', async () => {
    snapshot = state({ current: '0.9.0' });
    changelogAnswer = [release('0.10.0', [entry()]), release('0.8.0', [entry()])];
    await render(<UpdateView />);

    expect(
      Array.from(container.querySelectorAll('[data-release]')).map((el) =>
        el.getAttribute('data-release')
      )
    ).toEqual(['0.10.0']);
  });

  it('条目缺当前语言时回落到另一种 —— 双语日志是渐进补全的，不能留空白', async () => {
    snapshot = state();
    changelogAnswer = [release('0.75.0', [entry({ zh: null, en: 'english only entry' })])];
    await render(<UpdateView />);

    expect(text('.nexus-update-entry-text')).toBe('english only entry');
  });

  it('英文界面下同样回落', async () => {
    localeManager.setLocale('en-US');
    snapshot = state();
    changelogAnswer = [release('0.75.0', [entry({ zh: '只有中文这一句', en: null })])];
    await render(<UpdateView />);

    expect(text('.nexus-update-entry-text')).toBe('只有中文这一句');
  });

  it('一个版本没有条目时明说，而不是画一片空白', async () => {
    snapshot = state();
    changelogAnswer = [release('0.75.0', [])];
    await render(<UpdateView />);

    expect(container.querySelector('.nexus-update-release-empty')).not.toBeNull();
  });

  it('类型徽章只在**有译文**时画 —— 直接渲染会漏出 `update.type.xxx` 这种键名', async () => {
    snapshot = state();
    changelogAnswer = [
      release('0.75.0', [
        entry({ type: 'feat', zh: '有译文的类型' }),
        entry({ type: 'no-such-type', zh: '没有译文的类型' })
      ])
    ];
    await render(<UpdateView />);

    const badges = container.querySelectorAll('.nexus-update-entry-type');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent ?? '').not.toContain('update.type.');
  });

  it('从 GitHub 提交信息回落来的那一条要标出来源', async () => {
    snapshot = state();
    changelogAnswer = [
      release('0.75.0', [entry()], 'github'),
      release('0.70.0', [entry()], 'bundled')
    ];
    await render(<UpdateView />);

    // 默认视图只剩 0.75.0，它就是那条 github 来源。
    expect(container.querySelectorAll('.nexus-update-release-source')).toHaveLength(1);
  });

  it('内置来源不标 —— 只有「二手」的那些需要说明', async () => {
    snapshot = state();
    changelogAnswer = [release('0.75.0', [entry()], 'bundled')];
    await render(<UpdateView />);

    expect(container.querySelectorAll('.nexus-update-release-source')).toHaveLength(0);
  });
});

describe('更新窗口外壳', () => {
  it('标记自己是更新窗口，并装上更新本体', async () => {
    snapshot = state();
    changelogAnswer = [];
    await render(<UpdateWindow />);

    expect(container.querySelector('[data-window-role="update"]')).not.toBeNull();
    expect(container.querySelector('.nexus-update-view')).not.toBeNull();
  });

  it('标题栏有自绘窗口按钮，关闭键走到桥上', async () => {
    snapshot = state();
    changelogAnswer = [];
    await render(<UpdateWindow />);

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.nexus-app-root[data-window-role="update"] > .nexus-header-bar .nexus-window-button'
    );
    expect(buttons).toHaveLength(3);

    await act(async () => buttons[2]?.click());
    expect(calls.map((call) => call.name)).toEqual(['closeWindow']);
  });

  it('Escape 关窗', async () => {
    snapshot = state();
    changelogAnswer = [];
    await render(<UpdateWindow />);

    pressEscape();
    expect(calls.map((call) => call.name)).toEqual(['closeWindow']);
  });

  /** 将来往日志里加弹层时，那道 `defaultPrevented` 判断才起作用 —— 少了它关弹层会顺带关窗。 */
  it('Escape 已被别处处理时不再关窗', async () => {
    snapshot = state();
    changelogAnswer = [];
    await render(<UpdateWindow />);

    pressEscape(true);
    expect(calls).toEqual([]);
  });

  it('窗口骨架里没有主窗口的菜单栏与活动栏', async () => {
    snapshot = state();
    changelogAnswer = [];
    await render(<UpdateWindow />);

    expect(container.querySelector('.nexus-menu-bar')).toBeNull();
    expect(container.querySelector('.nexus-activity-bar')).toBeNull();
  });
});
