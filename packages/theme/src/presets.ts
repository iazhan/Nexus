/**
 * 生成物，不要手改 —— 由 `packages/theme/scripts/import-schemes.mjs` 从 tinted-theming 的
 * `schemes` 仓库（`spec-0.11` 分支）的 `base16/*.yaml` 写出。
 *
 * 重新生成：先 build（门禁函数从 `dist/` 取），再
 * `node packages/theme/scripts/import-schemes.mjs <schemes 检出目录>`。
 *
 * 收录哪些族由生成器里的 `FAMILIES` 白名单决定 —— 改白名单后重跑本脚本，**不要手工改这个文件**。
 * 明暗两套都过对比度门禁（容差见生成器的 `GATE_EPSILON`），缺一边或超出容差都会让生成失败。
 */

import type { NexusThemeScheme } from './seeds.js';

export interface BuiltInPreset {
  id: string;
  name: string;
  /**
   * 明暗两套。**出厂表里恒为两版齐全**（白名单要求），可选是因为这个形状要跟用户主题共用
   * —— 用户主题可以只有一边。
   */
  variants: { light?: string; dark?: string };
}

/** 40 套方案。id 与 `NexusThemeScheme` 成对，`BUILT_IN_SCHEMES` 直接消费。 */
export const BASE16_SCHEMES: readonly { id: string; scheme: NexusThemeScheme }[] = [
  {
    id: 'atelier-cave',
    scheme: {
      name: 'Atelier Cave',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#19171c', base01: '#26232a', base02: '#585260', base03: '#655f6d',
        base04: '#7e7887', base05: '#8b8792', base06: '#e2dfe7', base07: '#efecf4',
        base08: '#be4678', base09: '#aa573c', base0A: '#a06e3b', base0B: '#2a9292',
        base0C: '#398bc6', base0D: '#576ddb', base0E: '#955ae7', base0F: '#bf40bf'
      }
    }
  },
  {
    id: 'atelier-cave-light',
    scheme: {
      name: 'Atelier Cave Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#efecf4', base01: '#e2dfe7', base02: '#8b8792', base03: '#7e7887',
        base04: '#655f6d', base05: '#585260', base06: '#26232a', base07: '#19171c',
        base08: '#be4678', base09: '#aa573c', base0A: '#a06e3b', base0B: '#2a9292',
        base0C: '#398bc6', base0D: '#576ddb', base0E: '#955ae7', base0F: '#bf40bf'
      }
    }
  },
  {
    id: 'atelier-dune',
    scheme: {
      name: 'Atelier Dune',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#20201d', base01: '#292824', base02: '#6e6b5e', base03: '#7d7a68',
        base04: '#999580', base05: '#a6a28c', base06: '#e8e4cf', base07: '#fefbec',
        base08: '#d73737', base09: '#b65611', base0A: '#ae9513', base0B: '#60ac39',
        base0C: '#1fad83', base0D: '#6684e1', base0E: '#b854d4', base0F: '#d43552'
      }
    }
  },
  {
    id: 'atelier-dune-light',
    scheme: {
      name: 'Atelier Dune Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#fefbec', base01: '#e8e4cf', base02: '#a6a28c', base03: '#999580',
        base04: '#7d7a68', base05: '#6e6b5e', base06: '#292824', base07: '#20201d',
        base08: '#d73737', base09: '#b65611', base0A: '#ae9513', base0B: '#60ac39',
        base0C: '#1fad83', base0D: '#6684e1', base0E: '#b854d4', base0F: '#d43552'
      }
    }
  },
  {
    id: 'atelier-estuary',
    scheme: {
      name: 'Atelier Estuary',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#22221b', base01: '#302f27', base02: '#5f5e4e', base03: '#6c6b5a',
        base04: '#878573', base05: '#929181', base06: '#e7e6df', base07: '#f4f3ec',
        base08: '#ba6236', base09: '#ae7313', base0A: '#a5980d', base0B: '#7d9726',
        base0C: '#5b9d48', base0D: '#36a166', base0E: '#5f9182', base0F: '#9d6c7c'
      }
    }
  },
  {
    id: 'atelier-estuary-light',
    scheme: {
      name: 'Atelier Estuary Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f4f3ec', base01: '#e7e6df', base02: '#929181', base03: '#878573',
        base04: '#6c6b5a', base05: '#5f5e4e', base06: '#302f27', base07: '#22221b',
        base08: '#ba6236', base09: '#ae7313', base0A: '#a5980d', base0B: '#7d9726',
        base0C: '#5b9d48', base0D: '#36a166', base0E: '#5f9182', base0F: '#9d6c7c'
      }
    }
  },
  {
    id: 'atelier-forest',
    scheme: {
      name: 'Atelier Forest',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#1b1918', base01: '#2c2421', base02: '#68615e', base03: '#766e6b',
        base04: '#9c9491', base05: '#a8a19f', base06: '#e6e2e0', base07: '#f1efee',
        base08: '#f22c40', base09: '#df5320', base0A: '#c38418', base0B: '#7b9726',
        base0C: '#3d97b8', base0D: '#407ee7', base0E: '#6666ea', base0F: '#c33ff3'
      }
    }
  },
  {
    id: 'atelier-forest-light',
    scheme: {
      name: 'Atelier Forest Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f1efee', base01: '#e6e2e0', base02: '#a8a19f', base03: '#9c9491',
        base04: '#766e6b', base05: '#68615e', base06: '#2c2421', base07: '#1b1918',
        base08: '#f22c40', base09: '#df5320', base0A: '#c38418', base0B: '#7b9726',
        base0C: '#3d97b8', base0D: '#407ee7', base0E: '#6666ea', base0F: '#c33ff3'
      }
    }
  },
  {
    id: 'atelier-heath',
    scheme: {
      name: 'Atelier Heath',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#1b181b', base01: '#292329', base02: '#695d69', base03: '#776977',
        base04: '#9e8f9e', base05: '#ab9bab', base06: '#d8cad8', base07: '#f7f3f7',
        base08: '#ca402b', base09: '#a65926', base0A: '#bb8a35', base0B: '#918b3b',
        base0C: '#159393', base0D: '#516aec', base0E: '#7b59c0', base0F: '#cc33cc'
      }
    }
  },
  {
    id: 'atelier-heath-light',
    scheme: {
      name: 'Atelier Heath Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f7f3f7', base01: '#d8cad8', base02: '#ab9bab', base03: '#9e8f9e',
        base04: '#776977', base05: '#695d69', base06: '#292329', base07: '#1b181b',
        base08: '#ca402b', base09: '#a65926', base0A: '#bb8a35', base0B: '#918b3b',
        base0C: '#159393', base0D: '#516aec', base0E: '#7b59c0', base0F: '#cc33cc'
      }
    }
  },
  {
    id: 'atelier-lakeside',
    scheme: {
      name: 'Atelier Lakeside',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#161b1d', base01: '#1f292e', base02: '#516d7b', base03: '#5a7b8c',
        base04: '#7195a8', base05: '#7ea2b4', base06: '#c1e4f6', base07: '#ebf8ff',
        base08: '#d22d72', base09: '#935c25', base0A: '#8a8a0f', base0B: '#568c3b',
        base0C: '#2d8f6f', base0D: '#257fad', base0E: '#6b6bb8', base0F: '#b72dd2'
      }
    }
  },
  {
    id: 'atelier-lakeside-light',
    scheme: {
      name: 'Atelier Lakeside Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#ebf8ff', base01: '#c1e4f6', base02: '#7ea2b4', base03: '#7195a8',
        base04: '#5a7b8c', base05: '#516d7b', base06: '#1f292e', base07: '#161b1d',
        base08: '#d22d72', base09: '#935c25', base0A: '#8a8a0f', base0B: '#568c3b',
        base0C: '#2d8f6f', base0D: '#257fad', base0E: '#6b6bb8', base0F: '#b72dd2'
      }
    }
  },
  {
    id: 'atelier-plateau',
    scheme: {
      name: 'Atelier Plateau',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#1b1818', base01: '#292424', base02: '#585050', base03: '#655d5d',
        base04: '#7e7777', base05: '#8a8585', base06: '#e7dfdf', base07: '#f4ecec',
        base08: '#ca4949', base09: '#b45a3c', base0A: '#a06e3b', base0B: '#4b8b8b',
        base0C: '#5485b6', base0D: '#7272ca', base0E: '#8464c4', base0F: '#bd5187'
      }
    }
  },
  {
    id: 'atelier-plateau-light',
    scheme: {
      name: 'Atelier Plateau Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f4ecec', base01: '#e7dfdf', base02: '#8a8585', base03: '#7e7777',
        base04: '#655d5d', base05: '#585050', base06: '#292424', base07: '#1b1818',
        base08: '#ca4949', base09: '#b45a3c', base0A: '#a06e3b', base0B: '#4b8b8b',
        base0C: '#5485b6', base0D: '#7272ca', base0E: '#8464c4', base0F: '#bd5187'
      }
    }
  },
  {
    id: 'atelier-savanna',
    scheme: {
      name: 'Atelier Savanna',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#171c19', base01: '#232a25', base02: '#526057', base03: '#5f6d64',
        base04: '#78877d', base05: '#87928a', base06: '#dfe7e2', base07: '#ecf4ee',
        base08: '#b16139', base09: '#9f713c', base0A: '#a07e3b', base0B: '#489963',
        base0C: '#1c9aa0', base0D: '#478c90', base0E: '#55859b', base0F: '#867469'
      }
    }
  },
  {
    id: 'atelier-savanna-light',
    scheme: {
      name: 'Atelier Savanna Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#ecf4ee', base01: '#dfe7e2', base02: '#87928a', base03: '#78877d',
        base04: '#5f6d64', base05: '#526057', base06: '#232a25', base07: '#171c19',
        base08: '#b16139', base09: '#9f713c', base0A: '#a07e3b', base0B: '#489963',
        base0C: '#1c9aa0', base0D: '#478c90', base0E: '#55859b', base0F: '#867469'
      }
    }
  },
  {
    id: 'atelier-seaside',
    scheme: {
      name: 'Atelier Seaside',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#131513', base01: '#242924', base02: '#5e6e5e', base03: '#687d68',
        base04: '#809980', base05: '#8ca68c', base06: '#cfe8cf', base07: '#f4fbf4',
        base08: '#e6193c', base09: '#87711d', base0A: '#98981b', base0B: '#29a329',
        base0C: '#1999b3', base0D: '#3d62f5', base0E: '#ad2bee', base0F: '#e619c3'
      }
    }
  },
  {
    id: 'atelier-seaside-light',
    scheme: {
      name: 'Atelier Seaside Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f4fbf4', base01: '#cfe8cf', base02: '#8ca68c', base03: '#809980',
        base04: '#687d68', base05: '#5e6e5e', base06: '#242924', base07: '#131513',
        base08: '#e6193c', base09: '#87711d', base0A: '#98981b', base0B: '#29a329',
        base0C: '#1999b3', base0D: '#3d62f5', base0E: '#ad2bee', base0F: '#e619c3'
      }
    }
  },
  {
    id: 'atelier-sulphurpool',
    scheme: {
      name: 'Atelier Sulphurpool',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'dark',
      palette: {
        base00: '#202746', base01: '#293256', base02: '#5e6687', base03: '#6b7394',
        base04: '#898ea4', base05: '#979db4', base06: '#dfe2f1', base07: '#f5f7ff',
        base08: '#c94922', base09: '#c76b29', base0A: '#c08b30', base0B: '#ac9739',
        base0C: '#22a2c9', base0D: '#3d8fd1', base0E: '#6679cc', base0F: '#9c637a'
      }
    }
  },
  {
    id: 'atelier-sulphurpool-light',
    scheme: {
      name: 'Atelier Sulphurpool Light',
      author: 'Bram de Haan (http://atelierbramdehaan.nl)',
      variant: 'light',
      palette: {
        base00: '#f5f7ff', base01: '#dfe2f1', base02: '#979db4', base03: '#898ea4',
        base04: '#6b7394', base05: '#5e6687', base06: '#293256', base07: '#202746',
        base08: '#c94922', base09: '#c76b29', base0A: '#c08b30', base0B: '#ac9739',
        base0C: '#22a2c9', base0D: '#3d8fd1', base0E: '#6679cc', base0F: '#9c637a'
      }
    }
  },
  {
    id: 'ayu-dark',
    scheme: {
      name: 'Ayu Dark',
      author: 'Tinted Theming (https://github.com/tinted-theming), Ayu Theme (https://github.com/ayu-theme)',
      variant: 'dark',
      palette: {
        base00: '#0b0e14', base01: '#131721', base02: '#202229', base03: '#3e4b59',
        base04: '#bfbdb6', base05: '#e6e1cf', base06: '#ece8db', base07: '#f2f0e7',
        base08: '#f07178', base09: '#ff8f40', base0A: '#ffb454', base0B: '#aad94c',
        base0C: '#95e6cb', base0D: '#59c2ff', base0E: '#d2a6ff', base0F: '#e6b450'
      }
    }
  },
  {
    id: 'ayu-light',
    scheme: {
      name: 'Ayu Light',
      author: 'Tinted Theming (https://github.com/tinted-theming), Ayu Theme (https://github.com/ayu-theme)',
      variant: 'light',
      palette: {
        base00: '#f8f9fa', base01: '#edeff1', base02: '#d2d4d8', base03: '#a0a6ac',
        base04: '#8a9199', base05: '#5c6166', base06: '#4e5257', base07: '#404447',
        base08: '#f07171', base09: '#fa8d3e', base0A: '#f2ae49', base0B: '#6cbf49',
        base0C: '#4cbf99', base0D: '#399ee6', base0E: '#a37acc', base0F: '#e6ba7e'
      }
    }
  },
  {
    id: 'default-dark',
    scheme: {
      name: 'Default Dark',
      author: 'Chris Kempson (http://chriskempson.com)',
      variant: 'dark',
      palette: {
        base00: '#181818', base01: '#282828', base02: '#383838', base03: '#585858',
        base04: '#b8b8b8', base05: '#d8d8d8', base06: '#e8e8e8', base07: '#f8f8f8',
        base08: '#ab4642', base09: '#dc9656', base0A: '#f7ca88', base0B: '#a1b56c',
        base0C: '#86c1b9', base0D: '#7cafc2', base0E: '#ba8baf', base0F: '#a16946'
      }
    }
  },
  {
    id: 'default-light',
    scheme: {
      name: 'Default Light',
      author: 'Chris Kempson (http://chriskempson.com)',
      variant: 'light',
      palette: {
        base00: '#f8f8f8', base01: '#e8e8e8', base02: '#d8d8d8', base03: '#b8b8b8',
        base04: '#585858', base05: '#383838', base06: '#282828', base07: '#181818',
        base08: '#ab4642', base09: '#dc9656', base0A: '#f7ca88', base0B: '#a1b56c',
        base0C: '#86c1b9', base0D: '#7cafc2', base0E: '#ba8baf', base0F: '#a16946'
      }
    }
  },
  {
    id: 'github',
    scheme: {
      name: 'Github',
      author: 'Tinted Theming (https://github.com/tinted-theming)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#f6f8fa', base02: '#afb8c1', base03: '#8c959f',
        base04: '#6e7781', base05: '#424a53', base06: '#32383f', base07: '#1f2328',
        base08: '#953800', base09: '#0550ae', base0A: '#bf8700', base0B: '#0a3069',
        base0C: '#116329', base0D: '#8250df', base0E: '#cf222e', base0F: '#82071e'
      }
    }
  },
  {
    id: 'github-dark',
    scheme: {
      name: 'Github Dark',
      author: 'Tinted Theming (https://github.com/tinted-theming)',
      variant: 'dark',
      palette: {
        base00: '#0d1117', base01: '#161b22', base02: '#484f58', base03: '#6e7681',
        base04: '#8b949e', base05: '#c9d1d9', base06: '#f0f6fc', base07: '#ffffff',
        base08: '#ffa657', base09: '#79c0ff', base0A: '#bb8009', base0B: '#a5d6ff',
        base0C: '#7ee787', base0D: '#d2a8ff', base0E: '#ff7b72', base0F: '#ffa198'
      }
    }
  },
  {
    id: 'google-dark',
    scheme: {
      name: 'Google Dark',
      author: 'Seth Wright (http://sethawright.com)',
      variant: 'dark',
      palette: {
        base00: '#1d1f21', base01: '#282a2e', base02: '#373b41', base03: '#969896',
        base04: '#b4b7b4', base05: '#c5c8c6', base06: '#e0e0e0', base07: '#ffffff',
        base08: '#cc342b', base09: '#f96a38', base0A: '#fba922', base0B: '#198844',
        base0C: '#3971ed', base0D: '#3971ed', base0E: '#a36ac7', base0F: '#3971ed'
      }
    }
  },
  {
    id: 'google-light',
    scheme: {
      name: 'Google Light',
      author: 'Seth Wright (http://sethawright.com)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#e0e0e0', base02: '#c5c8c6', base03: '#b4b7b4',
        base04: '#969896', base05: '#373b41', base06: '#282a2e', base07: '#1d1f21',
        base08: '#cc342b', base09: '#f96a38', base0A: '#fba922', base0B: '#198844',
        base0C: '#3971ed', base0D: '#3971ed', base0E: '#a36ac7', base0F: '#3971ed'
      }
    }
  },
  {
    id: 'gruvbox-dark',
    scheme: {
      name: 'Gruvbox dark',
      author: 'Tinted Theming (https://github.com/tinted-theming), morhetz (https://github.com/morhetz/gruvbox)',
      variant: 'dark',
      palette: {
        base00: '#282828', base01: '#3c3836', base02: '#504945', base03: '#665c54',
        base04: '#928374', base05: '#ebdbb2', base06: '#fbf1c7', base07: '#f9f5d7',
        base08: '#cc241d', base09: '#d65d0e', base0A: '#d79921', base0B: '#98971a',
        base0C: '#689d6a', base0D: '#458588', base0E: '#b16286', base0F: '#9d0006'
      }
    }
  },
  {
    id: 'gruvbox-light',
    scheme: {
      name: 'Gruvbox Light',
      author: 'Tinted Theming (https://github.com/tinted-theming), morhetz (https://github.com/morhetz/gruvbox)',
      variant: 'light',
      palette: {
        base00: '#fbf1c7', base01: '#ebdbb2', base02: '#d5c4a1', base03: '#bdae93',
        base04: '#7c6f64', base05: '#3c3836', base06: '#282828', base07: '#1d2021',
        base08: '#cc241d', base09: '#d65d0e', base0A: '#d79921', base0B: '#98971a',
        base0C: '#689d6a', base0D: '#458588', base0E: '#b16286', base0F: '#9d0006'
      }
    }
  },
  {
    id: 'harmonic16-dark',
    scheme: {
      name: 'Harmonic16 Dark',
      author: 'Jannik Siebert (https://github.com/janniks)',
      variant: 'dark',
      palette: {
        base00: '#0b1c2c', base01: '#223b54', base02: '#405c79', base03: '#627e99',
        base04: '#aabcce', base05: '#cbd6e2', base06: '#e5ebf1', base07: '#f7f9fb',
        base08: '#bf8b56', base09: '#bfbf56', base0A: '#8bbf56', base0B: '#56bf8b',
        base0C: '#568bbf', base0D: '#8b56bf', base0E: '#bf568b', base0F: '#bf5656'
      }
    }
  },
  {
    id: 'harmonic16-light',
    scheme: {
      name: 'Harmonic16 Light',
      author: 'Jannik Siebert (https://github.com/janniks)',
      variant: 'light',
      palette: {
        base00: '#f7f9fb', base01: '#e5ebf1', base02: '#cbd6e2', base03: '#aabcce',
        base04: '#627e99', base05: '#405c79', base06: '#223b54', base07: '#0b1c2c',
        base08: '#bf8b56', base09: '#bfbf56', base0A: '#8bbf56', base0B: '#56bf8b',
        base0C: '#568bbf', base0D: '#8b56bf', base0E: '#bf568b', base0F: '#bf5656'
      }
    }
  },
  {
    id: 'nord',
    scheme: {
      name: 'Nord',
      author: 'arcticicestudio',
      variant: 'dark',
      palette: {
        base00: '#2e3440', base01: '#3b4252', base02: '#434c5e', base03: '#4c566a',
        base04: '#d8dee9', base05: '#e5e9f0', base06: '#eceff4', base07: '#8fbcbb',
        base08: '#bf616a', base09: '#d08770', base0A: '#ebcb8b', base0B: '#a3be8c',
        base0C: '#88c0d0', base0D: '#81a1c1', base0E: '#b48ead', base0F: '#5e81ac'
      }
    }
  },
  {
    id: 'nord-light',
    scheme: {
      name: 'Nord Light',
      author: 'threddast, based on fuxialexander\'s doom-nord-light-theme (Doom Emacs)',
      variant: 'light',
      palette: {
        base00: '#e5e9f0', base01: '#c2d0e7', base02: '#b8c5db', base03: '#aebacf',
        base04: '#60728c', base05: '#2e3440', base06: '#3b4252', base07: '#29838d',
        base08: '#99324b', base09: '#ac4426', base0A: '#9a7500', base0B: '#4f894c',
        base0C: '#398eac', base0D: '#3b6ea8', base0E: '#97365b', base0F: '#5272af'
      }
    }
  },
  {
    id: 'one-light',
    scheme: {
      name: 'One Light',
      author: 'Daniel Pfeifer (http://github.com/purpleKarrot)',
      variant: 'light',
      palette: {
        base00: '#fafafa', base01: '#f0f0f1', base02: '#e5e5e6', base03: '#a0a1a7',
        base04: '#696c77', base05: '#383a42', base06: '#202227', base07: '#090a0b',
        base08: '#ca1243', base09: '#d75f00', base0A: '#c18401', base0B: '#50a14f',
        base0C: '#0184bc', base0D: '#4078f2', base0E: '#a626a4', base0F: '#986801'
      }
    }
  },
  {
    id: 'onedark',
    scheme: {
      name: 'OneDark',
      author: 'Lalit Magant (http://github.com/tilal6991)',
      variant: 'dark',
      palette: {
        base00: '#282c34', base01: '#353b45', base02: '#3e4451', base03: '#545862',
        base04: '#565c64', base05: '#abb2bf', base06: '#b6bdca', base07: '#c8ccd4',
        base08: '#e06c75', base09: '#d19a66', base0A: '#e5c07b', base0B: '#98c379',
        base0C: '#56b6c2', base0D: '#61afef', base0E: '#c678dd', base0F: '#be5046'
      }
    }
  },
  {
    id: 'solarized-dark',
    scheme: {
      name: 'Solarized Dark',
      author: 'Ethan Schoonover (modified by aramisgithub)',
      variant: 'dark',
      palette: {
        base00: '#002b36', base01: '#073642', base02: '#586e75', base03: '#657b83',
        base04: '#839496', base05: '#93a1a1', base06: '#eee8d5', base07: '#fdf6e3',
        base08: '#dc322f', base09: '#cb4b16', base0A: '#b58900', base0B: '#859900',
        base0C: '#2aa198', base0D: '#268bd2', base0E: '#6c71c4', base0F: '#d33682'
      }
    }
  },
  {
    id: 'solarized-light',
    scheme: {
      name: 'Solarized Light',
      author: 'Ethan Schoonover (modified by aramisgithub)',
      variant: 'light',
      palette: {
        base00: '#fdf6e3', base01: '#eee8d5', base02: '#93a1a1', base03: '#839496',
        base04: '#657b83', base05: '#586e75', base06: '#073642', base07: '#002b36',
        base08: '#dc322f', base09: '#cb4b16', base0A: '#b58900', base0B: '#859900',
        base0C: '#2aa198', base0D: '#268bd2', base0E: '#6c71c4', base0F: '#d33682'
      }
    }
  },
  {
    id: 'tomorrow',
    scheme: {
      name: 'Tomorrow',
      author: 'Chris Kempson (http://chriskempson.com)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#e0e0e0', base02: '#c5c8c6', base03: '#b4b7b4',
        base04: '#969896', base05: '#373b41', base06: '#282a2e', base07: '#1d1f21',
        base08: '#c82829', base09: '#f5871f', base0A: '#eab700', base0B: '#718c00',
        base0C: '#3e999f', base0D: '#4271ae', base0E: '#8959a8', base0F: '#a3685a'
      }
    }
  },
  {
    id: 'tomorrow-night',
    scheme: {
      name: 'Tomorrow Night',
      author: 'Chris Kempson (http://chriskempson.com)',
      variant: 'dark',
      palette: {
        base00: '#1d1f21', base01: '#282a2e', base02: '#373b41', base03: '#969896',
        base04: '#b4b7b4', base05: '#c5c8c6', base06: '#e0e0e0', base07: '#ffffff',
        base08: '#cc6666', base09: '#de935f', base0A: '#f0c674', base0B: '#b5bd68',
        base0C: '#8abeb7', base0D: '#81a2be', base0E: '#b294bb', base0F: '#a3685a'
      }
    }
  }
];

/** 20 个族。预设轴选它，模式轴再决定取哪一边。 */
export const BASE16_PRESETS: readonly BuiltInPreset[] = [
  { id: 'default', name: 'Default', variants: { light: 'default-light', dark: 'default-dark' } },
  { id: 'ayu', name: 'Ayu', variants: { light: 'ayu-light', dark: 'ayu-dark' } },
  { id: 'github', name: 'GitHub', variants: { light: 'github', dark: 'github-dark' } },
  { id: 'one', name: 'OneDark / One Light', variants: { light: 'one-light', dark: 'onedark' } },
  { id: 'solarized', name: 'Solarized', variants: { light: 'solarized-light', dark: 'solarized-dark' } },
  { id: 'tomorrow', name: 'Tomorrow', variants: { light: 'tomorrow', dark: 'tomorrow-night' } },
  { id: 'gruvbox', name: 'Gruvbox', variants: { light: 'gruvbox-light', dark: 'gruvbox-dark' } },
  { id: 'nord', name: 'Nord', variants: { light: 'nord-light', dark: 'nord' } },
  { id: 'google', name: 'Google', variants: { light: 'google-light', dark: 'google-dark' } },
  { id: 'harmonic16', name: 'Harmonic', variants: { light: 'harmonic16-light', dark: 'harmonic16-dark' } },
  { id: 'atelier-cave', name: 'Atelier Cave', variants: { light: 'atelier-cave-light', dark: 'atelier-cave' } },
  { id: 'atelier-dune', name: 'Atelier Dune', variants: { light: 'atelier-dune-light', dark: 'atelier-dune' } },
  { id: 'atelier-estuary', name: 'Atelier Estuary', variants: { light: 'atelier-estuary-light', dark: 'atelier-estuary' } },
  { id: 'atelier-forest', name: 'Atelier Forest', variants: { light: 'atelier-forest-light', dark: 'atelier-forest' } },
  { id: 'atelier-heath', name: 'Atelier Heath', variants: { light: 'atelier-heath-light', dark: 'atelier-heath' } },
  { id: 'atelier-lakeside', name: 'Atelier Lakeside', variants: { light: 'atelier-lakeside-light', dark: 'atelier-lakeside' } },
  { id: 'atelier-plateau', name: 'Atelier Plateau', variants: { light: 'atelier-plateau-light', dark: 'atelier-plateau' } },
  { id: 'atelier-savanna', name: 'Atelier Savanna', variants: { light: 'atelier-savanna-light', dark: 'atelier-savanna' } },
  { id: 'atelier-seaside', name: 'Atelier Seaside', variants: { light: 'atelier-seaside-light', dark: 'atelier-seaside' } },
  { id: 'atelier-sulphurpool', name: 'Atelier Sulphurpool', variants: { light: 'atelier-sulphurpool-light', dark: 'atelier-sulphurpool' } }
];
