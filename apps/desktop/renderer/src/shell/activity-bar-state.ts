/**
 * 活动栏（Activity Bar）的布局状态。
 *
 * 参照 VSCode：最左一列图标，点击在右侧展开对应面板，再点同一个图标则收起。
 *
 * ## 为什么是两个字段而不是一个 `activeId | null`
 *
 * 「选中哪个图标」和「面板是否可见」是**两件事**：
 *   - 面板收起后，图标仍然保持高亮（它表示「上次看的是这个」）—— 这是 VSCode 的行为；
 *   - 面板切换时不能先关再开，否则宽度动画会闪一下。
 * 一个可空字段表达不了这两点，硬凑就会在实现里到处补丁。
 */

export type ActivityId =
  | 'workspace'
  | 'outline'
  | 'search'
  | 'tags'
  | 'graph'
  | 'history'
  | 'extensions';

export interface ActivityState {
  /** 当前选中的图标。**收起面板后不重置** —— 否则「上次看的是哪个」就丢了。 */
  activeId: ActivityId;
  /** 面板是否展开 */
  panelOpen: boolean;
}

/**
 * 初始状态：**展开**工作区面板。
 *
 * 早先这里是 `panelOpen: false`，结果是「图标亮着、面板却关着」—— 视觉上自相矛盾。
 * 「收起后图标仍高亮」是**收起之后**的行为（表示上次看的是哪个），不该拿来当初始状态。
 * 启动时展开也符合 VSCode：它的 Explorer 默认就是开着的。
 */
export const INITIAL_ACTIVITY_STATE: ActivityState = Object.freeze({
  activeId: 'workspace',
  panelOpen: true
});

/**
 * 点击一个图标后的新状态。
 *
 * - 点的是**已展开**的那个图标 → 收起（`activeId` 保持不变）
 * - 点的是别的图标（或面板已收起）→ 展开并切换过去
 *
 * 切换时 `panelOpen` 保持 `true`，面板内容是直接替换的 —— 不经过「关→开」，
 * 否则宽度会归零再展开，看起来闪一下。
 */
export function toggleActivity(state: ActivityState, clicked: ActivityId): ActivityState {
  if (state.activeId === clicked && state.panelOpen) {
    return { ...state, panelOpen: false };
  }
  return { activeId: clicked, panelOpen: true };
}

/** 收起面板（快捷键用）。已经收起时返回同一个引用，避免无谓的重渲染。 */
export function collapseActivity(state: ActivityState): ActivityState {
  if (!state.panelOpen) return state;
  return { ...state, panelOpen: false };
}
