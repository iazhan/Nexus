import { describe, expect, it } from 'vitest';
import {
  BIRTH_HALO_ALPHA,
  birthHaloAlpha,
  birthHaloRadius,
  birthRadiusFactor
} from '../src/workspace/graph-birth.js';

/**
 * 出生动画的几何。
 *
 * 这两条算式此前直接写在绘制 effect 里（`0.4 + 0.6 * birth`），**只能靠肉眼验**：
 * 画布上的东西从外部定位不到，而动画只持续几百毫秒。抽成纯函数之后可以按半径断言。
 *
 * 最要紧的一条是「就位之后不再画光晕」—— 留一圈常驻外环是这个特性最容易出的错，
 * 而它只在动画结束之后才出现，那时候没人盯着看。
 */
const BASE = 10;

describe('图谱出生动画的几何', () => {
  it('半径从 0.4 倍长到 1 倍', () => {
    expect(birthRadiusFactor(0)).toBeCloseTo(0.4, 6);
    expect(birthRadiusFactor(1)).toBe(1);

    // 单调递增：中途回头的话看着是「先涨后缩」的抽动
    const samples = [0, 0.25, 0.5, 0.75, 1].map(birthRadiusFactor);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!).toBeGreaterThan(samples[index - 1]!);
    }
  });

  it('光晕始终在实体之外，且随出生进度收缩', () => {
    const half = birthHaloRadius(BASE, 0.5);
    expect(half).not.toBeNull();

    // 正：光晕半径必须大于**当前帧**画出来的实体半径，否则它被实体盖住、等于没画
    expect(half!).toBeGreaterThan(BASE * birthRadiusFactor(0.5));
    // 正：出生到一半时的绘制半径大于「完全就位」的实体半径 —— 光环在收缩
    expect(half!).toBeGreaterThan(BASE);

    const samples = [0, 0.25, 0.5, 0.75].map((birth) => birthHaloRadius(BASE, birth)!);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!).toBeLessThan(samples[index - 1]!);
    }
  });

  it('光晕至少比实体宽 2px —— 缩到最小时也看得见', () => {
    // 缩放到下限时一个节点只有一两个像素宽，靠比例算出来的光晕会细到看不出来
    const tiny = 1.5;
    const drawn = tiny * birthRadiusFactor(0.9);
    expect(birthHaloRadius(tiny, 0.9)! - drawn).toBeGreaterThanOrEqual(2);
  });

  it('完全就位之后**不再**画光晕', () => {
    /*
      反例：`birth = 1` 时算式本身会退化成「实体 + 2px」，仍然是个环。
      真画出来就是静止的图外面常驻一层外圈 —— 比没有光晕更糟，因为它看着像渲染故障。
    */
    expect(birthHaloRadius(BASE, 1)).toBeNull();
    // 越界值不能翻过来变成「画一个很大的光晕」
    expect(birthHaloRadius(BASE, 1.2)).toBeNull();
    expect(birthHaloRadius(BASE, Number.NaN)).toBeNull();
  });

  it('光晕的不透明度与半径一起收敛到 0', () => {
    expect(birthHaloAlpha(0)).toBeCloseTo(BIRTH_HALO_ALPHA, 6);
    expect(birthHaloAlpha(0.5)).toBeLessThan(birthHaloAlpha(0));
    // 与 `birthHaloRadius` 同一条边界：到 1 就没有任何东西要画
    expect(birthHaloAlpha(1)).toBe(0);
  });
});
