import { describe, it, expect } from 'vitest';
import {
  INITIAL_ACTIVITY_STATE,
  collapseActivity,
  toggleActivity,
  type ActivityState
} from '../src/shell/activity-bar-state.js';

/**
 * 活动栏布局状态（VSCode 式侧栏）。
 *
 * 这个 reducer 只有两条规则，但两条都有容易做错的地方：
 *   - 「再点同一个图标收起」要保留 activeId（**不是**为了高亮 —— 高亮是
 *     `activeId && panelOpen` 派生的，收起时会消失；保留它是为了「下次展开还是这一屏」）
 *   - 「切换图标」不能经过「关→开」（否则宽度动画会闪）
 *
 * 高亮本身的判据在组件层，用例在 `activity-bar.test.tsx`。
 */
describe('活动栏状态', () => {
  it('初始状态自洽：图标选中的同时面板就是打开的', () => {
    // 早先这里是 panelOpen: false —— 结果是「图标亮着、面板却关着」的视觉矛盾。
    // 「收起后图标仍高亮」是收起之后的行为，不该拿来当初始状态。
    expect(INITIAL_ACTIVITY_STATE).toEqual({ activeId: 'workspace', panelOpen: true });
  });

  it('点击别的图标是切换过去', () => {
    const next = toggleActivity(INITIAL_ACTIVITY_STATE, 'search');
    expect(next).toEqual({ activeId: 'search', panelOpen: true });
  });

  it('再点已展开的图标则收起，但 activeId 保留', () => {
    const opened: ActivityState = { activeId: 'workspace', panelOpen: true };
    const closed = toggleActivity(opened, 'workspace');

    expect(closed.panelOpen).toBe(false);
    // 关键：activeId 留着 —— 下次展开还是这一屏，面板槽也还挂在它上面。
    // 但**图标不再高亮**，那由组件按 `activeId && panelOpen` 派生。
    expect(closed.activeId).toBe('workspace');
  });

  it('收起后再点同一个图标，重新展开（而不是切到别的）', () => {
    const closed: ActivityState = { activeId: 'outline', panelOpen: false };
    expect(toggleActivity(closed, 'outline')).toEqual({
      activeId: 'outline',
      panelOpen: true
    });
  });

  it('点另一个图标是切换，panelOpen 始终保持 true', () => {
    const opened: ActivityState = { activeId: 'workspace', panelOpen: true };
    const switched = toggleActivity(opened, 'search');

    expect(switched).toEqual({ activeId: 'search', panelOpen: true });
    // 不能出现 panelOpen 中途变 false —— 那会让宽度动画闪一下
    expect(switched.panelOpen).toBe(true);
  });

  it('在多个面板之间来回切换不会把面板关掉', () => {
    // 从「收起且选中 workspace」开始，这样第一次点击是展开、后续都是切换
    let state: ActivityState = { activeId: 'workspace', panelOpen: false };
    for (const id of ['workspace', 'outline', 'search', 'extensions', 'workspace'] as const) {
      state = toggleActivity(state, id);
      expect(state.panelOpen).toBe(true);
      expect(state.activeId).toBe(id);
    }
  });

  it('collapseActivity 收起面板并保留 activeId', () => {
    const opened = toggleActivity(INITIAL_ACTIVITY_STATE, 'extensions');
    const collapsed = collapseActivity(opened);

    expect(collapsed).toEqual({ activeId: 'extensions', panelOpen: false });
  });

  it('已经收起时 collapseActivity 返回同一个引用', () => {
    const alreadyClosed: ActivityState = { activeId: 'workspace', panelOpen: false };
    // 同一引用 → 不会触发无谓的重渲染
    expect(collapseActivity(alreadyClosed)).toBe(alreadyClosed);
  });
});
