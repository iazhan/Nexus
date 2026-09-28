import { describe, it, expect } from 'vitest';
import { nexusLight, nexusDark } from '../src/index.js';
import {
  FOREGROUND_CONTRACT,
  GENERAL_SURFACES,
  OVERLAYS,
  SURFACES,
  contrastRatio,
  measureTheme,
  parseColour,
  relativeLuminance,
  type ContrastFailure,
} from '../src/contrast.js';

const THEMES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['light', nexusLight.tokens],
  ['dark', nexusDark.tokens],
];

const keyOf = (theme: string, failure: ContrastFailure): string => `${theme}/${failure.token}@${failure.ground}`;

/** 契约表实际测到的对数：每套 140 对。数字变了说明承载面或契约被改动，需要一并复核。 */
const MEASURED_PER_THEME = 140;

/** 装饰边框豁免：不参与测量，但必须显式列出，不能靠「没测到」。 */
const EXEMPT_BORDER_TOKENS = ['border-default', 'border-strong', 'border-subtle'];

describe('对比度契约的完整性', () => {
  it('每个 token 都被分类为前景、承载面或覆盖层', () => {
    const all = Object.keys(nexusLight.tokens);
    const classified = new Set([...Object.keys(FOREGROUND_CONTRACT), ...SURFACES, ...OVERLAYS]);

    expect(all.filter((token) => !classified.has(token))).toEqual([]);
    expect([...classified].filter((token) => !all.includes(token))).toEqual([]);
  });

  it('两套主题的 token 名一致', () => {
    expect(Object.keys(nexusDark.tokens).sort()).toEqual(Object.keys(nexusLight.tokens).sort());
  });

  it('豁免清单只含边框类，且与契约表一致', () => {
    const borders = Object.entries(FOREGROUND_CONTRACT)
      .filter(([, contract]) => contract.tier === 'border')
      .map(([token]) => token)
      .sort();

    expect(borders).toEqual([...EXEMPT_BORDER_TOKENS].sort());
    for (const token of EXEMPT_BORDER_TOKENS) {
      expect(FOREGROUND_CONTRACT[token]?.on, `${token} 豁免了就不该再配承载面`).toEqual([]);
    }
  });

  it('拆分后不再有 token 兼承载面与前景', () => {
    // accent 的两个身份（图形 / 按钮底）已分成 accent-indicator 与 accent-solid，
    // 交集应当为空 —— 非空就说明又有 token 在两头站。
    const dual = SURFACES.filter((surface) => surface in FOREGROUND_CONTRACT);
    expect(dual).toEqual([]);
  });

  it('契约表引用的承载面都真实存在', () => {
    const all = new Set(Object.keys(nexusLight.tokens));
    const referenced = new Set(Object.values(FOREGROUND_CONTRACT).flatMap((contract) => [...contract.on]));

    expect([...referenced].filter((token) => !all.has(token))).toEqual([]);
  });

  it('通用背景不含作用域限定的表面', () => {
    for (const surface of GENERAL_SURFACES) {
      expect(surface, `${surface} 不该出现在通用背景里`).not.toMatch(/^(status-|syntax-inline-code)/);
    }
  });
});

describe('前缀推断踩过的四个坑（回归锁）', () => {
  it('accent-contrast 只落在主色实心底上，不是通用背景', () => {
    expect(FOREGROUND_CONTRACT['accent-contrast']?.on).toEqual([
      'accent-solid',
      'accent-solid-hover',
    ]);
  });

  it('accent-indicator 按图形类（3:1），不是文字类', () => {
    expect(FOREGROUND_CONTRACT['accent-indicator']?.tier).toBe('graphical');
  });

  it('accent-solid-hover 是按钮 hover 的底，不是前景', () => {
    expect(FOREGROUND_CONTRACT['accent-solid-hover']).toBeUndefined();
    expect(SURFACES).toContain('accent-solid-hover');
  });

  it('status-*-border 按图形类实测，不跟装饰边框一起豁免', () => {
    // 按 `-border` 后缀归一类是错的口径：状态边框是语义指示器（1.4.11 适用），
    // border-subtle/default/strong 是分隔线（纯装饰）。实测过的数字在 derive.test.ts。
    for (const scope of ['success', 'warning', 'error']) {
      const token = `status-${scope}-border`;
      expect(FOREGROUND_CONTRACT[token]?.tier, `${token} 该按图形级测`).toBe('graphical');
      for (const surface of GENERAL_SURFACES) {
        expect(FOREGROUND_CONTRACT[token]?.on, `${token} 该落在通用背景上`).toContain(surface);
      }
    }
  });

  it('status-*-text 同时落在状态条与通用背景上', () => {
    for (const scope of ['success', 'warning', 'error']) {
      const on = FOREGROUND_CONTRACT[`status-${scope}-text`]?.on ?? [];
      for (const surface of GENERAL_SURFACES) expect(on).toContain(surface);
    }

    expect(FOREGROUND_CONTRACT['status-warning-text']?.on).toContain('status-warning-bg');
    expect(FOREGROUND_CONTRACT['status-error-text']?.on).toContain('status-error-bg');
    // success 没有状态底色 token，别在契约表里凭空引用
    expect(FOREGROUND_CONTRACT['status-success-text']?.on).not.toContain('status-success-bg');
  });
});

describe('色彩数学', () => {
  it('黑白对比度是 21:1，同色是 1:1', () => {
    const white = parseColour('#ffffff') as NonNullable<ReturnType<typeof parseColour>>;
    const black = parseColour('#000000') as NonNullable<ReturnType<typeof parseColour>>;

    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
  });

  it('解析 #rgb / #rrggbb / #rrggbbaa / rgba()', () => {
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour('#007acc')).toEqual({ r: 0, g: 122, b: 204, a: 1 });
    expect(parseColour('#00000080')?.a).toBeCloseTo(128 / 255, 5);
    expect(parseColour('rgba(0, 122, 204, 0.2)')).toEqual({ r: 0, g: 122, b: 204, a: 0.2 });
    expect(parseColour('color-mix(in oklab, red 50%, transparent)')).toBeNull();
  });

  it('半透明承载面先与基准合成再测', () => {
    const text = parseColour('#ffffff') as NonNullable<ReturnType<typeof parseColour>>;
    const scrim = parseColour('rgba(0, 0, 0, 0.5)') as NonNullable<ReturnType<typeof parseColour>>;
    const white = parseColour('#ffffff') as NonNullable<ReturnType<typeof parseColour>>;

    // 未合成会得到 21:1（把遮罩当成纯黑）；合成后是中灰，约 3.95:1
    expect(contrastRatio(text, scrim)).toBeCloseTo(3.95, 1);
    expect(contrastRatio(text, scrim, white)).toBeCloseTo(3.95, 1);
  });
});

describe('对比度不变量', () => {
  // 接线派生之前这里挂着一张 50 对（light 31 / dark 19）的「已知不达标」清单当回归网；
  // 派生生效后清单缩到空，于是改成直接断言零不达标 —— 契约表才是唯一的判据。
  it('两套内置主题零不达标', () => {
    let measured = 0;

    for (const [name, tokens] of THEMES) {
      const report = measureTheme(tokens);
      measured += report.measured;
      expect(report.measured, `${name} 的测量对数变了`).toBe(MEASURED_PER_THEME);
      expect(
        report.failures.map((failure) => keyOf(name, failure)),
        `${name} 有不达标的配对`,
      ).toEqual([]);
    }

    expect(measured).toBe(MEASURED_PER_THEME * THEMES.length);
  });
});
