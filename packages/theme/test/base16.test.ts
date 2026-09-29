import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_SCHEMES,
  base16Slug,
  inferVariant,
  parseBase16,
  serializeBase16,
  type Base16Scheme
} from '../src/index.js';
import { BASE16_SLOTS } from '../src/seeds.js';

/** spec 0.11 的嵌套形状，逐字取自 tinted-theming 的 `base16/dracula.yaml`（含注释）。 */
const DRACULA_YAML = `system: "base16"
name: "Dracula"
author: "clach04 (https://github.com/clach04)"
description: "based on https://github.com/dracula/draculatheme.com/blob/main/content/spec.mdx"
variant: "dark"
palette:
  base00: "#282a36"  # Default Background
  base01: "#21222c"  # Darker Background
  base02: "#44475A"
  base03: "#6272a4"
  base04: "#9ea8c7"
  base05: "#f8f8f2"
  base06: "#f8f8f2"
  base07: "#ffffff"
  base08: "#ff5555"
  base09: "#FFB86C"
  base0A: "#f1fa8c"
  base0B: "#50fa7b"
  base0C: "#8be9fd"
  base0D: "#bd93f9"
  base0E: "#ff79c6"
  base0F: "#993333"
`;

/** spec ≤ 0.10 的扁平形状：`scheme:` + 顶层 16 行。 */
const LEGACY_FLAT_YAML = `scheme: "Legacy"
author: "someone"
base00: "1a1b26"
base01: "16161e"
base02: "2f3549"
base03: "444b6a"
base04: "787c99"
base05: "a9b1d6"
base06: "cbccd1"
base07: "d5d6db"
base08: "c0caf5"
base09: "a9b1d6"
base0A: "0db9d7"
base0B: "9ece6a"
base0C: "b4f9f8"
base0D: "2ac3de"
base0E: "bb9af7"
base0F: "f7768e"
`;

const parsed = (text: string): Base16Scheme => {
  const result = parseBase16(text);
  if (!result.ok) throw new Error(`本该解析成功，却拿到 ${result.error.code}`);
  return result.scheme;
};

describe('parseBase16 · 形状', () => {
  it('spec 0.11 的嵌套形状：name / author / variant 都取到', () => {
    const scheme = parsed(DRACULA_YAML);

    expect(scheme.name).toBe('Dracula');
    expect(scheme.author).toBe('clach04 (https://github.com/clach04)');
    expect(scheme.variant).toBe('dark');
    expect(Object.keys(scheme.palette)).toHaveLength(16);
    expect(scheme.palette.base00).toBe('#282a36');
    expect(scheme.palette.base0F).toBe('#993333');
  });

  /** `description` 里的 URL 含 `//`，`system:` 也不是槽位 —— 非槽位键必须被安静忽略。 */
  it('非槽位键一律忽略，不报错也不进 palette', () => {
    const scheme = parsed(DRACULA_YAML);

    expect(scheme.palette).not.toHaveProperty('system');
    expect(scheme.palette).not.toHaveProperty('description');
    expect(Object.keys(scheme.palette).sort()).toEqual([...BASE16_SLOTS].sort());
  });

  it('spec ≤ 0.10 的扁平形状：名字从 `scheme` 取，色值可以不带 #', () => {
    const scheme = parsed(LEGACY_FLAT_YAML);

    expect(scheme.name).toBe('Legacy');
    expect(scheme.author).toBe('someone');
    expect(scheme.palette.base00).toBe('#1a1b26');
    expect(scheme.palette.base0D).toBe('#2ac3de');
  });

  it('JSON 的两种形状都收', () => {
    const nested = parsed(
      JSON.stringify({ name: 'J', variant: 'light', palette: { ...parsed(DRACULA_YAML).palette } })
    );
    expect(nested.name).toBe('J');
    expect(nested.variant).toBe('light');

    const flat = parsed(JSON.stringify({ scheme: 'F', ...parsed(DRACULA_YAML).palette }));
    expect(flat.name).toBe('F');
  });

  it('文件里没有名字时用兜底名字', () => {
    const withoutName = DRACULA_YAML.replace(/^name: .*\n/m, '');
    expect(parseBase16(withoutName, 'my-theme')).toMatchObject({
      ok: true,
      scheme: { name: 'my-theme' }
    });
  });
});

describe('parseBase16 · variant', () => {
  it('显式声明优先于推断', () => {
    // 一份暗色种子被标成 light —— 显式声明要赢，否则用户改不了方向。
    const scheme = parsed(DRACULA_YAML.replace('"dark"', '"light"'));
    expect(scheme.variant).toBe('light');
  });

  it('缺省时按 base00 比 base05 暗 → 暗色', () => {
    const withoutVariant = DRACULA_YAML.replace(/^variant: .*\n/m, '');
    expect(parsed(withoutVariant).variant).toBe('dark');
  });

  it('base00 比 base05 亮 → 亮色', () => {
    expect(inferVariant({ base00: '#ffffff', base05: '#111111' })).toBe('light');
    expect(inferVariant({ base00: '#111111', base05: '#ffffff' })).toBe('dark');
  });

  it('两个槽位都解析不了时按亮色，不抛', () => {
    expect(inferVariant({})).toBe('light');
  });
});

describe('parseBase16 · 严格性', () => {
  it('缺槽位报出**具体槽位名**，而不是用默认值补齐', () => {
    const missing = DRACULA_YAML.replace(/^ {2}base0A: .*\n/m, '');
    const result = parseBase16(missing);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: 'missing-slots', slots: ['base0A'] } });
  });

  it('缺多个槽位时全列出来', () => {
    const missing = DRACULA_YAML.replace(/^ {2}base0[89]: .*\n/gm, '');
    const result = parseBase16(missing);

    expect(result).toMatchObject({ error: { code: 'missing-slots', slots: ['base08', 'base09'] } });
  });

  it('色值不是 hex 就拒收，带上槽位与原值', () => {
    const result = parseBase16(DRACULA_YAML.replace('#ff5555', 'rgb(255, 85, 85)'));

    expect(result).toMatchObject({
      error: { code: 'invalid-colour', slot: 'base08', value: 'rgb(255, 85, 85)' }
    });
  });

  it('空文件与数组各有自己的错误码', () => {
    expect(parseBase16('   ')).toMatchObject({ error: { code: 'empty' } });
    expect(parseBase16('[]')).toMatchObject({ error: { code: 'not-a-scheme' } });
    expect(parseBase16('{ 坏 json')).toMatchObject({ error: { code: 'not-a-scheme' } });
  });
});

describe('parseBase16 · 归一化与注释', () => {
  it('大小写归一化成小写 #rrggbb', () => {
    const scheme = parsed(DRACULA_YAML);
    expect(scheme.palette.base02).toBe('#44475a'); // 原文 #44475A
    expect(scheme.palette.base09).toBe('#ffb86c'); // 原文 #FFB86C
  });

  it('3 位写法展开、8 位丢掉 alpha', () => {
    const scheme = parsed(DRACULA_YAML.replace('#44475A', '#48c').replace('#993333', '#99333380'));
    expect(scheme.palette.base02).toBe('#4488cc');
    expect(scheme.palette.base0F).toBe('#993333');
  });

  /**
   * 行尾注释的判据：`#` 只有在**引号外且前面是空白**时才是注释。
   * 色值本身以 `#` 开头，判错的症状是「所有槽位都缺」。
   */
  it('剥掉行尾注释，但不动引号里的 #', () => {
    const scheme = parsed(DRACULA_YAML);

    expect(scheme.palette.base00).toBe('#282a36'); // 后面跟了 `# Default Background`
    expect(scheme.palette.base01).toBe('#21222c');
  });
});

describe('serializeBase16', () => {
  it('YAML 写出 spec 0.11 的嵌套形状', () => {
    const text = serializeBase16(parsed(DRACULA_YAML));

    expect(text.startsWith('system: "base16"\n')).toBe(true);
    expect(text).toContain('name: "Dracula"');
    expect(text).toContain('variant: "dark"');
    expect(text).toContain('\npalette:\n  base00: "#282a36"\n');
    expect(text).toContain('  base0F: "#993333"\n');
  });

  it('没有 author 时不写那一行', () => {
    const text = serializeBase16({ ...parsed(DRACULA_YAML), author: undefined });
    expect(text).not.toContain('author:');
  });

  it('JSON 形状带 system / variant / palette', () => {
    const payload = JSON.parse(serializeBase16(parsed(DRACULA_YAML), 'json')) as Record<string, unknown>;

    expect(payload.system).toBe('base16');
    expect(payload.name).toBe('Dracula');
    expect(payload.variant).toBe('dark');
    expect(Object.keys(payload.palette as object)).toHaveLength(16);
  });

  /** 往返是导出功能唯一的正确性判据：写出去的东西必须能被自己读回来，且逐字段一致。 */
  it('往返一致（YAML 与 JSON）', () => {
    for (const { scheme } of BUILT_IN_SCHEMES) {
      expect(parsed(serializeBase16(scheme, 'yaml'))).toEqual(scheme);
      expect(parsed(serializeBase16(scheme, 'json'))).toEqual(scheme);
    }
  });

  it('往返保住 3 位写法展开后的值，不保住原写法 —— 归一化是单向的', () => {
    const compact: Base16Scheme = {
      ...parsed(DRACULA_YAML),
      palette: { ...parsed(DRACULA_YAML).palette, base00: '#48c' }
    };
    expect(parsed(serializeBase16(compact)).palette.base00).toBe('#4488cc');
  });
});

describe('base16Slug', () => {
  it('导出文件名用的 slug', () => {
    expect(base16Slug('Tokyo Night Dark')).toBe('tokyo-night-dark');
    expect(base16Slug('Dracula Theme!')).toBe('dracula-theme');
    expect(base16Slug('  ')).toBe('theme');
  });
});
