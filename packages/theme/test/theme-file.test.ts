import { describe, it, expect } from 'vitest';
import { parseBase16, parseThemeFile, serializeThemeFile } from '../src/index.js';
import { nexusDarkSeeds, nexusLightSeeds } from '../src/seeds.js';

const USER_ID = 'user:9f3c1a44-0a5b-4c7d-9e11-2b6f0d8a3c51';

/** 逐字取自 tinted-theming 的 `base16/dracula.yaml`：上游文件里**没有** `nexus:` 块。 */
const UPSTREAM_YAML = `system: "base16"
name: "Dracula"
author: "clach04 (https://github.com/clach04)"
variant: "dark"
palette:
  base00: "#282a36"
  base01: "#21222c"
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

const ok = (text: string, fallbackName?: string) => {
  const result = parseThemeFile(text, fallbackName);
  if (!result.ok) throw new Error(`本该解析成功，却拿到 ${result.error.code}`);
  return result;
};

describe('serializeThemeFile', () => {
  it('写出来的 base16 部分仍然是一份合法的 base16 方案（上游工具读得懂）', () => {
    const text = serializeThemeFile(USER_ID, nexusLightSeeds);
    const upstream = parseBase16(text);

    // 正面：16 个槽位与名字都在。
    expect(upstream.ok).toBe(true);
    if (!upstream.ok) return;
    expect(upstream.scheme.name).toBe('Nexus Light');
    expect(upstream.scheme.variant).toBe('light');
    expect(upstream.scheme.palette).toEqual(nexusLightSeeds.palette);
  });

  it('`nexus:` 块里的 id 一定带 `user:` 前缀 —— 否则读回来会被当成「没有 id」', () => {
    const text = serializeThemeFile(USER_ID, nexusLightSeeds);
    expect(text).toContain(`nexus:\n  id: "${USER_ID}"`);
    expect(ok(text).id).toBe(USER_ID);
  });

  it('空的 tuning / overrides 不写出来（「没有调参」与「调参全是默认值」不是一回事）', () => {
    const bare = serializeThemeFile(USER_ID, nexusLightSeeds);
    expect(bare).not.toContain('tuning:');
    expect(bare).not.toContain('overrides:');

    const tuned = serializeThemeFile(USER_ID, {
      ...nexusLightSeeds,
      tuning: { surfaceHover: 0.04 },
      overrides: { accent: '#e6b450' }
    });
    expect(tuned).toContain('tuning:\n    surfaceHover: 0.04');
    expect(tuned).toContain('overrides:\n    accent: "#e6b450"');
  });
});

describe('parseThemeFile', () => {
  it('往返：写出去再读回来，逐字段相等', () => {
    const scheme = {
      ...nexusDarkSeeds,
      author: 'someone',
      tuning: { surfaceHover: 0.04, borderStrong: 0.2 },
      overrides: { accent: '#e6b450', 'text-muted': '#888888' }
    };
    const back = ok(serializeThemeFile(USER_ID, scheme));

    expect(back.id).toBe(USER_ID);
    expect(back.scheme).toEqual(scheme);
  });

  it('上游文件（没有 `nexus:` 块）：照样读得出来，id 交给调用方从文件名推', () => {
    const result = ok(UPSTREAM_YAML, 'dracula');

    expect(result.id).toBeNull();
    expect(result.scheme.name).toBe('Dracula');
    expect(result.scheme.variant).toBe('dark');
    expect(result.scheme.palette.base0D).toBe('#bd93f9');
    expect(result.scheme.tuning).toBeUndefined();
    expect(result.scheme.overrides).toBeUndefined();
  });

  it('CRLF 的行尾不影响解析（手改过的文件在 Windows 上就是 CRLF）', () => {
    const crlf = serializeThemeFile(USER_ID, nexusLightSeeds).replace(/\n/g, '\r\n');
    const back = ok(crlf);
    expect(back.id).toBe(USER_ID);
    expect(back.scheme.palette).toEqual(nexusLightSeeds.palette);
  });

  it('id 不带 `user:` 前缀时当作没有 id —— 内置 id 被写成用户主题的话，「切回 Nexus Light」得到的是改过的 Nexus Light', () => {
    const text = `${UPSTREAM_YAML}nexus:\n  id: "nexus-light"\n`;
    expect(ok(text, 'x').id).toBeNull();
  });

  it('不采信 `nexus.overrides` 之外的颜色字段（那是绕过派生管线）', () => {
    const text = `${UPSTREAM_YAML}accent: "#ff0000"\nbackground: "#000000"\n`;
    const back = ok(text, 'x');
    expect(back.scheme.overrides).toBeUndefined();
  });

  it('认不出的调参键与不是颜色的覆盖值丢掉，其余照常读', () => {
    const text = `${UPSTREAM_YAML}nexus:
  id: "${USER_ID}"
  tuning:
    surfaceHover: 0.04
    notATuningKey: 0.9
  overrides:
    accent: "#e6b450"
    broken: "not a colour"
`;
    const back = ok(text, 'x');
    expect(back.scheme.tuning).toEqual({ surfaceHover: 0.04 });
    expect(back.scheme.overrides).toEqual({ accent: '#e6b450' });
  });

  it('色值里的 `#` 不会被当成行尾注释吃掉（它前面有空白，但它在引号里）', () => {
    const text = `${UPSTREAM_YAML}nexus:\n  id: "${USER_ID}"\n  overrides:\n    accent: "#e6b450"  # 说明\n`;
    expect(ok(text, 'x').scheme.overrides).toEqual({ accent: '#e6b450' });
  });

  it('`nexus:` 块之后回到顶格的键不再属于这个块', () => {
    const text = `${UPSTREAM_YAML}nexus:\n  id: "${USER_ID}"\ntuning:\n  surfaceHover: 0.5\n`;
    expect(ok(text, 'x').scheme.tuning).toBeUndefined();
  });

  it('坏文件按 base16 的错误码报出来，不抛', () => {
    const empty = parseThemeFile('   \n', 'x');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('empty');

    const missing = parseThemeFile('system: "base16"\nname: "x"\nvariant: "dark"\n', 'x');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('missing-slots');
  });
});
