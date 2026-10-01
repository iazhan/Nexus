import { describe, expect, it } from 'vitest';
import {
  OUTLINE_LEVELS,
  OUTLINE_LEVEL_DEFAULT,
  OUTLINE_LEVEL_OPTIONS,
  outlineLevelToMaxLevel
} from '../src/settings/preference-specs.js';

/**
 * 大纲层级过滤的**值域**。
 *
 * 消费端（`buildOutlineRenderItems` 的 `maxLevel`）与渲染端（大纲面板）各自有自己的用例；
 * 这里只管「四个档位、默认不过滤、认不出的档位怎么办」。
 */

describe('大纲层级：值域', () => {
  it('默认不过滤，与加这一项之前的行为一致', () => {
    expect(OUTLINE_LEVEL_DEFAULT).toBe('all');
    expect(outlineLevelToMaxLevel(OUTLINE_LEVEL_DEFAULT)).toBeNull();
  });

  it('每个档位都有自己的选项与译文键', () => {
    // 加了档位却忘了选项，设置页就会少一项 —— 而「值能存进去但选不到」是最难查的那种
    expect(OUTLINE_LEVEL_OPTIONS.map((option) => option.value)).toEqual([...OUTLINE_LEVELS]);

    for (const option of OUTLINE_LEVEL_OPTIONS) {
      expect(option.labelKey).toBe(`settings.editor.outlineLevel.${option.value}`);
    }
  });

  it('档位 → maxLevel', () => {
    expect(outlineLevelToMaxLevel('1')).toBe(1);
    expect(outlineLevelToMaxLevel('2')).toBe(2);
    expect(outlineLevelToMaxLevel('3')).toBe(3);
  });

  it('认不出的档位按「不过滤」处理', () => {
    // 方向与默认值同向：一个坏字节不该把大纲藏掉一半。
    // 也顺带挡住 `Number()` 的坑 —— `Number('')` 是 0、`Number('abc')` 是 NaN，
    // 直接拿去当 maxLevel 会得到「什么都不显示」或不可预测的结果。
    expect(outlineLevelToMaxLevel('')).toBeNull();
    expect(outlineLevelToMaxLevel('abc')).toBeNull();
    expect(outlineLevelToMaxLevel('0')).toBeNull();
    expect(outlineLevelToMaxLevel('-1')).toBeNull();
    expect(outlineLevelToMaxLevel('2.5')).toBeNull();
    expect(outlineLevelToMaxLevel('ALL')).toBeNull();
  });
});
