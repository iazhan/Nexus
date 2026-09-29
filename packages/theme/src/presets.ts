/**
 * 生成物，不要手改 —— 由 `packages/theme/scripts/import-schemes.mjs` 从 tinted-theming 的
 * `schemes` 仓库（`spec-0.11` 分支）的 `base16/*.yaml` 写出。
 *
 * 重新生成：先 build（门禁函数从 `dist/` 取），再
 * `node packages/theme/scripts/import-schemes.mjs <schemes 检出目录>`。
 *
 * 只收录**明暗两套都过对比度门禁**的族，外加 `dracula`（上游只有暗版，但它是既有出厂主题）。
 * 被门禁挡下的族不会出现在这里，改动上游数据后重跑本脚本即可 —— 不要手工往数组里加条目。
 */

import type { NexusThemeScheme } from './seeds.js';

export interface BuiltInPreset {
  id: string;
  name: string;
  /** 至少有一个。单变体预设（上游只有一版）只填其中一边。 */
  variants: { light?: string; dark?: string };
}

/** 105 套方案。id 与 `NexusThemeScheme` 成对，`BUILT_IN_SCHEMES` 直接消费。 */
export const BASE16_SCHEMES: readonly { id: string; scheme: NexusThemeScheme }[] = [
  {
    id: 'arroz-con-dulce',
    scheme: {
      name: 'Arroz con Dulce',
      author: 'Richard Martinez',
      variant: 'light',
      palette: {
        base00: '#fff8e7', base01: '#f7ebd3', base02: '#ead6b8', base03: '#c8a77a',
        base04: '#765b45', base05: '#4a2c20', base06: '#321c14', base07: '#21110b',
        base08: '#a11d48', base09: '#a3470a', base0A: '#855500', base0B: '#a2380c',
        base0C: '#98263e', base0D: '#5940a0', base0E: '#8c1f68', base0F: '#653221'
      }
    }
  },
  {
    id: 'arroz-con-dulce-dark',
    scheme: {
      name: 'Arroz con Dulce Dark',
      author: 'Richard Martinez',
      variant: 'dark',
      palette: {
        base00: '#21140f', base01: '#2c1a13', base02: '#3b241a', base03: '#a98568',
        base04: '#c8a77a', base05: '#f2dfc0', base06: '#f8ebd3', base07: '#fff8e7',
        base08: '#e07a8a', base09: '#e68a4a', base0A: '#d9a441', base0B: '#d47a50',
        base0C: '#d98276', base0D: '#b99ac8', base0E: '#d58ab4', base0F: '#b97755'
      }
    }
  },
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
    id: 'cerulean-signal-dark',
    scheme: {
      name: 'Cerulean Signal Dark',
      author: 'Aaron Colichia (https://aaron.colichia.org/)',
      variant: 'dark',
      palette: {
        base00: '#101722', base01: '#131c29', base02: '#173a5a', base03: '#8fa0b5',
        base04: '#aab8ca', base05: '#dce6f2', base06: '#f1f6fc', base07: '#f7f9fc',
        base08: '#ff8a9a', base09: '#f5a35c', base0A: '#e2c85f', base0B: '#70e1b0',
        base0C: '#58d9df', base0D: '#7dd3ff', base0E: '#ff74d4', base0F: '#d59b7d'
      }
    }
  },
  {
    id: 'cerulean-signal-light',
    scheme: {
      name: 'Cerulean Signal Light',
      author: 'Aaron Colichia (https://aaron.colichia.org/)',
      variant: 'light',
      palette: {
        base00: '#f7f9fc', base01: '#eef4fb', base02: '#dde7f1', base03: '#637287',
        base04: '#566579', base05: '#232b38', base06: '#202b3a', base07: '#141d2a',
        base08: '#b4233d', base09: '#9a4f00', base0A: '#6f6300', base0B: '#17795e',
        base0C: '#00727e', base0D: '#006fa8', base0E: '#a0007d', base0F: '#7a4e3c'
      }
    }
  },
  {
    id: 'charcoal-dark',
    scheme: {
      name: 'Charcoal Dark',
      author: 'Mubin Muhammad (https://github.com/mubin6th)',
      variant: 'dark',
      palette: {
        base00: '#0f0b05', base01: '#231b0e', base02: '#2a2012', base03: '#57462c',
        base04: '#a88c62', base05: '#c3a983', base06: '#dec8a7', base07: '#231b0e',
        base08: '#a88c62', base09: '#dec8a7', base0A: '#dec8a7', base0B: '#dec8a7',
        base0C: '#dec8a7', base0D: '#c3a983', base0E: '#a88c62', base0F: '#876e48'
      }
    }
  },
  {
    id: 'charcoal-light',
    scheme: {
      name: 'Charcoal Light',
      author: 'Mubin Muhammad (https://github.com/mubin6th)',
      variant: 'light',
      palette: {
        base00: '#cabda0', base01: '#bcad8c', base02: '#af9f7d', base03: '#645538',
        base04: '#110e06', base05: '#382e1b', base06: '#4b3e26', base07: '#bcad8c',
        base08: '#382e1b', base09: '#110e06', base0A: '#110e06', base0B: '#110e06',
        base0C: '#110e06', base0D: '#251e0f', base0E: '#382e1b', base0F: '#4b3e26'
      }
    }
  },
  {
    id: 'classic-dark',
    scheme: {
      name: 'Classic Dark',
      author: 'Jason Heeris (http://heeris.id.au)',
      variant: 'dark',
      palette: {
        base00: '#151515', base01: '#202020', base02: '#303030', base03: '#505050',
        base04: '#b0b0b0', base05: '#d0d0d0', base06: '#e0e0e0', base07: '#f5f5f5',
        base08: '#ac4142', base09: '#d28445', base0A: '#f4bf75', base0B: '#90a959',
        base0C: '#75b5aa', base0D: '#6a9fb5', base0E: '#aa759f', base0F: '#8f5536'
      }
    }
  },
  {
    id: 'classic-light',
    scheme: {
      name: 'Classic Light',
      author: 'Jason Heeris (http://heeris.id.au)',
      variant: 'light',
      palette: {
        base00: '#f5f5f5', base01: '#e0e0e0', base02: '#d0d0d0', base03: '#b0b0b0',
        base04: '#505050', base05: '#303030', base06: '#202020', base07: '#151515',
        base08: '#ac4142', base09: '#d28445', base0A: '#f4bf75', base0B: '#90a959',
        base0C: '#75b5aa', base0D: '#6a9fb5', base0E: '#aa759f', base0F: '#8f5536'
      }
    }
  },
  {
    id: 'danqing',
    scheme: {
      name: 'DanQing',
      author: 'Wenhan Zhu (Cosmos) (zhuwenhan950913@gmail.com)',
      variant: 'dark',
      palette: {
        base00: '#2d302f', base01: '#434846', base02: '#5a605d', base03: '#9da8a3',
        base04: '#cad8d2', base05: '#e0f0ef', base06: '#ecf6f2', base07: '#fcfefd',
        base08: '#f9906f', base09: '#b38a61', base0A: '#f0c239', base0B: '#8ab361',
        base0C: '#30dff3', base0D: '#b0a4e3', base0E: '#cca4e3', base0F: '#ca6924'
      }
    }
  },
  {
    id: 'danqing-light',
    scheme: {
      name: 'DanQing Light',
      author: 'Wenhan Zhu (Cosmos) (zhuwenhan950913@gmail.com)',
      variant: 'light',
      palette: {
        base00: '#fcfefd', base01: '#ecf6f2', base02: '#e0f0ef', base03: '#cad8d2',
        base04: '#9da8a3', base05: '#5a605d', base06: '#434846', base07: '#2d302f',
        base08: '#f9906f', base09: '#b38a61', base0A: '#f0c239', base0B: '#8ab361',
        base0C: '#30dff3', base0D: '#b0a4e3', base0E: '#cca4e3', base0F: '#ca6924'
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
    id: 'dracula',
    scheme: {
      name: 'Dracula',
      author: 'clach04 (https://github.com/clach04)',
      variant: 'dark',
      palette: {
        base00: '#282a36', base01: '#21222c', base02: '#44475a', base03: '#6272a4',
        base04: '#9ea8c7', base05: '#f8f8f2', base06: '#f8f8f2', base07: '#ffffff',
        base08: '#ff5555', base09: '#ffb86c', base0A: '#f1fa8c', base0B: '#50fa7b',
        base0C: '#8be9fd', base0D: '#bd93f9', base0E: '#ff79c6', base0F: '#993333'
      }
    }
  },
  {
    id: 'embers',
    scheme: {
      name: 'Embers',
      author: 'Jannik Siebert (https://github.com/janniks)',
      variant: 'dark',
      palette: {
        base00: '#16130f', base01: '#2c2620', base02: '#433b32', base03: '#5a5047',
        base04: '#8a8075', base05: '#a39a90', base06: '#beb6ae', base07: '#dbd6d1',
        base08: '#826d57', base09: '#828257', base0A: '#6d8257', base0B: '#57826d',
        base0C: '#576d82', base0D: '#6d5782', base0E: '#82576d', base0F: '#825757'
      }
    }
  },
  {
    id: 'embers-light',
    scheme: {
      name: 'Embers Light',
      author: 'Jannik Siebert (https://github.com/janniks)',
      variant: 'light',
      palette: {
        base00: '#dbd6d1', base01: '#beb6ae', base02: '#a39a90', base03: '#8a8075',
        base04: '#5a5047', base05: '#433b32', base06: '#2c2620', base07: '#16130f',
        base08: '#826d57', base09: '#828257', base0A: '#6d8257', base0B: '#57826d',
        base0C: '#576d82', base0D: '#6d5782', base0E: '#82576d', base0F: '#825757'
      }
    }
  },
  {
    id: 'equilibrium-dark',
    scheme: {
      name: 'Equilibrium Dark',
      author: 'Carlo Abelli',
      variant: 'dark',
      palette: {
        base00: '#0c1118', base01: '#181c22', base02: '#22262d', base03: '#7b776e',
        base04: '#949088', base05: '#afaba2', base06: '#cac6bd', base07: '#e7e2d9',
        base08: '#f04339', base09: '#df5923', base0A: '#bb8801', base0B: '#7f8b00',
        base0C: '#00948b', base0D: '#008dd1', base0E: '#6a7fd2', base0F: '#e3488e'
      }
    }
  },
  {
    id: 'equilibrium-gray-dark',
    scheme: {
      name: 'Equilibrium Gray Dark',
      author: 'Carlo Abelli',
      variant: 'dark',
      palette: {
        base00: '#111111', base01: '#1b1b1b', base02: '#262626', base03: '#777777',
        base04: '#919191', base05: '#ababab', base06: '#c6c6c6', base07: '#e2e2e2',
        base08: '#f04339', base09: '#df5923', base0A: '#bb8801', base0B: '#7f8b00',
        base0C: '#00948b', base0D: '#008dd1', base0E: '#6a7fd2', base0F: '#e3488e'
      }
    }
  },
  {
    id: 'equilibrium-gray-light',
    scheme: {
      name: 'Equilibrium Gray Light',
      author: 'Carlo Abelli',
      variant: 'light',
      palette: {
        base00: '#f1f1f1', base01: '#e2e2e2', base02: '#d4d4d4', base03: '#777777',
        base04: '#5e5e5e', base05: '#474747', base06: '#303030', base07: '#1b1b1b',
        base08: '#d02023', base09: '#bf3e05', base0A: '#9d6f00', base0B: '#637200',
        base0C: '#007a72', base0D: '#0073b5', base0E: '#4e66b6', base0F: '#c42775'
      }
    }
  },
  {
    id: 'equilibrium-light',
    scheme: {
      name: 'Equilibrium Light',
      author: 'Carlo Abelli',
      variant: 'light',
      palette: {
        base00: '#f5f0e7', base01: '#e7e2d9', base02: '#d8d4cb', base03: '#73777f',
        base04: '#5a5f66', base05: '#43474e', base06: '#2c3138', base07: '#181c22',
        base08: '#d02023', base09: '#bf3e05', base0A: '#9d6f00', base0B: '#637200',
        base0C: '#007a72', base0D: '#0073b5', base0E: '#4e66b6', base0F: '#c42775'
      }
    }
  },
  {
    id: 'flexoki-dark',
    scheme: {
      name: 'Flexoki Dark',
      author: 'Steph Ango (https://github.com/kepano/flexoki)',
      variant: 'dark',
      palette: {
        base00: '#100f0f', base01: '#1c1b1a', base02: '#282726', base03: '#575653',
        base04: '#878580', base05: '#cecdc3', base06: '#e6e4d9', base07: '#fffcf0',
        base08: '#d14d41', base09: '#da702c', base0A: '#d0a215', base0B: '#879a39',
        base0C: '#3aa99f', base0D: '#4385be', base0E: '#8b7ec8', base0F: '#ce5d97'
      }
    }
  },
  {
    id: 'flexoki-light',
    scheme: {
      name: 'Flexoki Light',
      author: 'Steph Ango (https://github.com/kepano/flexoki)',
      variant: 'light',
      palette: {
        base00: '#fffcf0', base01: '#f2f0e5', base02: '#e6e4d9', base03: '#cecdc3',
        base04: '#9f9d96', base05: '#403e3c', base06: '#282726', base07: '#100f0f',
        base08: '#af3029', base09: '#bc5215', base0A: '#ad8301', base0B: '#66800b',
        base0C: '#24837b', base0D: '#205ea6', base0E: '#5e409d', base0F: '#a02f6f'
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
    id: 'grayscale-dark',
    scheme: {
      name: 'Grayscale Dark',
      author: 'Alexandre Gavioli (https://github.com/Alexx2/)',
      variant: 'dark',
      palette: {
        base00: '#101010', base01: '#252525', base02: '#464646', base03: '#525252',
        base04: '#ababab', base05: '#b9b9b9', base06: '#e3e3e3', base07: '#f7f7f7',
        base08: '#7c7c7c', base09: '#999999', base0A: '#a0a0a0', base0B: '#8e8e8e',
        base0C: '#868686', base0D: '#686868', base0E: '#747474', base0F: '#5e5e5e'
      }
    }
  },
  {
    id: 'grayscale-light',
    scheme: {
      name: 'Grayscale Light',
      author: 'Alexandre Gavioli (https://github.com/Alexx2/)',
      variant: 'light',
      palette: {
        base00: '#f7f7f7', base01: '#e3e3e3', base02: '#b9b9b9', base03: '#ababab',
        base04: '#525252', base05: '#464646', base06: '#252525', base07: '#101010',
        base08: '#7c7c7c', base09: '#999999', base0A: '#a0a0a0', base0B: '#8e8e8e',
        base0C: '#868686', base0D: '#686868', base0E: '#747474', base0F: '#5e5e5e'
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
    id: 'heetch',
    scheme: {
      name: 'Heetch Dark',
      author: 'Geoffrey Teale (tealeg@gmail.com)',
      variant: 'dark',
      palette: {
        base00: '#190134', base01: '#392551', base02: '#5a496e', base03: '#7b6d8b',
        base04: '#9c92a8', base05: '#bdb6c5', base06: '#dedae2', base07: '#feffff',
        base08: '#27d9d5', base09: '#5ba2b6', base0A: '#8f6c97', base0B: '#c33678',
        base0C: '#f80059', base0D: '#bd0152', base0E: '#82034c', base0F: '#470546'
      }
    }
  },
  {
    id: 'heetch-light',
    scheme: {
      name: 'Heetch Light',
      author: 'Geoffrey Teale (tealeg@gmail.com), Tinted Theming (https://github.com/tinted-theming)',
      variant: 'light',
      palette: {
        base00: '#feffff', base01: '#dedae2', base02: '#bdb6c5', base03: '#9c92a8',
        base04: '#7b6d8b', base05: '#5a496e', base06: '#392551', base07: '#190134',
        base08: '#f80059', base09: '#bd0152', base0A: '#bd9701', base0B: '#5bb66a',
        base0C: '#47f9f5', base0D: '#5ba2b6', base0E: '#8f6c97', base0F: '#58425d'
      }
    }
  },
  {
    id: 'horizon-dark',
    scheme: {
      name: 'Horizon Dark',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'dark',
      palette: {
        base00: '#1c1e26', base01: '#232530', base02: '#2e303e', base03: '#6f6f70',
        base04: '#9da0a2', base05: '#cbced0', base06: '#dcdfe4', base07: '#e3e6ee',
        base08: '#e93c58', base09: '#e58d7d', base0A: '#efb993', base0B: '#efaf8e',
        base0C: '#24a8b4', base0D: '#df5273', base0E: '#b072d1', base0F: '#e4a382'
      }
    }
  },
  {
    id: 'horizon-light',
    scheme: {
      name: 'Horizon Light',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'light',
      palette: {
        base00: '#fdf0ed', base01: '#fadad1', base02: '#f9cbbe', base03: '#bdb3b1',
        base04: '#948c8a', base05: '#403c3d', base06: '#302c2d', base07: '#201c1d',
        base08: '#f7939b', base09: '#f6661e', base0A: '#fbe0d9', base0B: '#94e1b0',
        base0C: '#dc3318', base0D: '#da103f', base0E: '#1d8991', base0F: '#e58c92'
      }
    }
  },
  {
    id: 'horizon-terminal-dark',
    scheme: {
      name: 'Horizon Terminal Dark',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'dark',
      palette: {
        base00: '#1c1e26', base01: '#232530', base02: '#2e303e', base03: '#6f6f70',
        base04: '#9da0a2', base05: '#cbced0', base06: '#dcdfe4', base07: '#e3e6ee',
        base08: '#e95678', base09: '#fab795', base0A: '#fac29a', base0B: '#29d398',
        base0C: '#59e1e3', base0D: '#26bbd9', base0E: '#ee64ac', base0F: '#f09383'
      }
    }
  },
  {
    id: 'horizon-terminal-light',
    scheme: {
      name: 'Horizon Terminal Light',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'light',
      palette: {
        base00: '#fdf0ed', base01: '#fadad1', base02: '#f9cbbe', base03: '#bdb3b1',
        base04: '#948c8a', base05: '#403c3d', base06: '#302c2d', base07: '#201c1d',
        base08: '#e95678', base09: '#f9cec3', base0A: '#fadad1', base0B: '#29d398',
        base0C: '#59e1e3', base0D: '#26bbd9', base0E: '#ee64ac', base0F: '#f9cbbe'
      }
    }
  },
  {
    id: 'humanoid-dark',
    scheme: {
      name: 'Humanoid dark',
      author: 'Thomas (tasmo) Friese',
      variant: 'dark',
      palette: {
        base00: '#232629', base01: '#333b3d', base02: '#484e54', base03: '#60615d',
        base04: '#c0c0bd', base05: '#f8f8f2', base06: '#fcfcf6', base07: '#fcfcfc',
        base08: '#f11235', base09: '#ff9505', base0A: '#ffb627', base0B: '#02d849',
        base0C: '#0dd9d6', base0D: '#00a6fb', base0E: '#f15ee3', base0F: '#b27701'
      }
    }
  },
  {
    id: 'humanoid-light',
    scheme: {
      name: 'Humanoid light',
      author: 'Thomas (tasmo) Friese',
      variant: 'light',
      palette: {
        base00: '#f8f8f2', base01: '#efefe9', base02: '#deded8', base03: '#c0c0bd',
        base04: '#60615d', base05: '#232629', base06: '#2f3337', base07: '#070708',
        base08: '#b0151a', base09: '#ff3d00', base0A: '#ffb627', base0B: '#388e3c',
        base0C: '#008e8e', base0D: '#0082c9', base0E: '#700f98', base0F: '#b27701'
      }
    }
  },
  {
    id: 'ia-dark',
    scheme: {
      name: 'iA Dark',
      author: 'iA Inc. (modified by aramisgithub)',
      variant: 'dark',
      palette: {
        base00: '#1a1a1a', base01: '#222222', base02: '#1d414d', base03: '#767676',
        base04: '#b8b8b8', base05: '#cccccc', base06: '#e8e8e8', base07: '#f8f8f8',
        base08: '#d88568', base09: '#d86868', base0A: '#b99353', base0B: '#83a471',
        base0C: '#7c9cae', base0D: '#8eccdd', base0E: '#b98eb2', base0F: '#8b6c37'
      }
    }
  },
  {
    id: 'ia-light',
    scheme: {
      name: 'iA Light',
      author: 'iA Inc. (modified by aramisgithub)',
      variant: 'light',
      palette: {
        base00: '#f6f6f6', base01: '#dedede', base02: '#bde5f2', base03: '#898989',
        base04: '#767676', base05: '#181818', base06: '#e8e8e8', base07: '#f8f8f8',
        base08: '#9c5a02', base09: '#c43e18', base0A: '#c48218', base0B: '#38781c',
        base0C: '#2d6bb1', base0D: '#48bac2', base0E: '#a94598', base0F: '#8b6c37'
      }
    }
  },
  {
    id: 'lichen-chartreuse-dark',
    scheme: {
      name: 'Lichen Chartreuse Dark',
      author: 'Aaron Colichia (https://aaron.colichia.org/)',
      variant: 'dark',
      palette: {
        base00: '#151613', base01: '#1c1e1a', base02: '#3e5123', base03: '#899282',
        base04: '#a0a598', base05: '#e0e5da', base06: '#ecefe7', base07: '#fcfcfa',
        base08: '#e28b82', base09: '#d5ad73', base0A: '#b2d084', base0B: '#83bda5',
        base0C: '#9cc6c9', base0D: '#78adc4', base0E: '#bfa6d4', base0F: '#d2a0b2'
      }
    }
  },
  {
    id: 'lichen-chartreuse-light',
    scheme: {
      name: 'Lichen Chartreuse Light',
      author: 'Aaron Colichia (https://aaron.colichia.org/)',
      variant: 'light',
      palette: {
        base00: '#f5f7f2', base01: '#ecefe7', base02: '#cfe4ae', base03: '#687161',
        base04: '#4e5149', base05: '#2d302b', base06: '#232420', base07: '#151613',
        base08: '#a34740', base09: '#8b5d27', base0A: '#506b29', base0B: '#2f7462',
        base0C: '#356569', base0D: '#356e8a', base0E: '#6e5689', base0F: '#8a4f67'
      }
    }
  },
  {
    id: 'measured-dark',
    scheme: {
      name: 'Measured Dark',
      author: 'Measured (https://measured.co)',
      variant: 'dark',
      palette: {
        base00: '#00211f', base01: '#003a38', base02: '#005453', base03: '#ababab',
        base04: '#c3c3c3', base05: '#dcdcdc', base06: '#efefef', base07: '#f5f5f5',
        base08: '#ce7e8e', base09: '#dca37c', base0A: '#bfac4e', base0B: '#56c16f',
        base0C: '#62c0be', base0D: '#88b0da', base0E: '#b39be0', base0F: '#d89aba'
      }
    }
  },
  {
    id: 'measured-light',
    scheme: {
      name: 'Measured Light',
      author: 'Measured (https://measured.co)',
      variant: 'light',
      palette: {
        base00: '#fdf9f5', base01: '#f9f5f1', base02: '#ffeada', base03: '#5a5a5a',
        base04: '#404040', base05: '#292929', base06: '#181818', base07: '#000000',
        base08: '#ac1f35', base09: '#ad5601', base0A: '#645a00', base0B: '#0c680c',
        base0C: '#01716f', base0D: '#0158ad', base0E: '#6645c2', base0F: '#a81a66'
      }
    }
  },
  {
    id: 'neovim-dark',
    scheme: {
      name: 'Neovim Dark',
      author: 'https://github.com/neovim/neovim/blob/master/src/nvim/highlight_group.c',
      variant: 'dark',
      palette: {
        base00: '#14161b', base01: '#07080d', base02: '#4f5258', base03: '#9b9ea4',
        base04: '#c4c6cd', base05: '#e0e2ea', base06: '#eef1f8', base07: '#eef1f8',
        base08: '#ffc0b9', base09: '#ffa500', base0A: '#fce094', base0B: '#b3f6c0',
        base0C: '#8cf8f7', base0D: '#a6dbff', base0E: '#ffcaff', base0F: '#cd853f'
      }
    }
  },
  {
    id: 'neovim-light',
    scheme: {
      name: 'Neovim Light',
      author: 'https://github.com/neovim/neovim/blob/master/src/nvim/highlight_group.c',
      variant: 'light',
      palette: {
        base00: '#e0e2ea', base01: '#eef1f8', base02: '#9b9ea4', base03: '#4f5258',
        base04: '#2c2e33', base05: '#14161b', base06: '#07080d', base07: '#07080d',
        base08: '#590008', base09: '#8b4513', base0A: '#6b5300', base0B: '#005523',
        base0C: '#007373', base0D: '#004c73', base0E: '#470045', base0F: '#a52a2a'
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
    id: 'papercolor-dark',
    scheme: {
      name: 'PaperColor Dark',
      author: 'Jon Leopard (http://github.com/jonleopard), Tinted Theming (https://github.com/tinted-theming), based on PaperColor Theme (https://github.com/NLKNguyen/papercolor-theme)',
      variant: 'dark',
      palette: {
        base00: '#1c1c1c', base01: '#363636', base02: '#424242', base03: '#585858',
        base04: '#808080', base05: '#9e9e9e', base06: '#b8b8b8', base07: '#d0d0d0',
        base08: '#ff5faf', base09: '#d7af5f', base0A: '#ffaf00', base0B: '#5faf5f',
        base0C: '#00afaf', base0D: '#5fafd7', base0E: '#af87d7', base0F: '#af005f'
      }
    }
  },
  {
    id: 'papercolor-light',
    scheme: {
      name: 'PaperColor Light',
      author: 'Jon Leopard (http://github.com/jonleopard), Tinted Theming (https://github.com/tinted-theming), based on PaperColor Theme (https://github.com/NLKNguyen/papercolor-theme)',
      variant: 'light',
      palette: {
        base00: '#eeeeee', base01: '#c4c4c4', base02: '#9e9e9e', base03: '#858585',
        base04: '#6b6b6b', base05: '#5e5e5e', base06: '#525252', base07: '#444444',
        base08: '#d70000', base09: '#d75f00', base0A: '#d75f00', base0B: '#008700',
        base0C: '#0087af', base0D: '#005f87', base0E: '#8700af', base0F: '#af0000'
      }
    }
  },
  {
    id: 'pastelon-de-amarillos',
    scheme: {
      name: 'Pastelón de Amarillos',
      author: 'Richard Martinez (https://sonofmartinus.com)',
      variant: 'light',
      palette: {
        base00: '#fff4d6', base01: '#f2d083', base02: '#d69b45', base03: '#80616b',
        base04: '#684653', base05: '#432c3b', base06: '#2f1c2e', base07: '#1c0f20',
        base08: '#bd3548', base09: '#ad570f', base0A: '#946400', base0B: '#167451',
        base0C: '#007270', base0D: '#1e5da8', base0E: '#8d3f89', base0F: '#7c3528'
      }
    }
  },
  {
    id: 'pastelon-de-amarillos-dark',
    scheme: {
      name: 'Pastelón de Amarillos Dark',
      author: 'Richard Martinez (https://sonofmartinus.com)',
      variant: 'dark',
      palette: {
        base00: '#180d18', base01: '#2a1424', base02: '#432031', base03: '#a0747c',
        base04: '#c39a89', base05: '#ffe0a3', base06: '#ffebc5', base07: '#fff7e6',
        base08: '#ff646a', base09: '#f99a32', base0A: '#ffc84a', base0B: '#3ccb83',
        base0C: '#35c4b6', base0D: '#5a9fe6', base0E: '#d978cf', base0F: '#e2764a'
      }
    }
  },
  {
    id: 'penumbra-dark',
    scheme: {
      name: 'Penumbra Dark',
      author: 'Zachary Weiss (https://github.com/zacharyweiss)',
      variant: 'dark',
      palette: {
        base00: '#24272b', base01: '#303338', base02: '#3e4044', base03: '#636363',
        base04: '#8f8f8f', base05: '#bebebe', base06: '#fff7ed', base07: '#fffdfb',
        base08: '#ca736c', base09: '#ba823a', base0A: '#8d9741', base0B: '#47a477',
        base0C: '#00a2af', base0D: '#5794d0', base0E: '#9481cc', base0F: '#bc73a4'
      }
    }
  },
  {
    id: 'penumbra-light',
    scheme: {
      name: 'Penumbra Light',
      author: 'Zachary Weiss (https://github.com/zacharyweiss)',
      variant: 'light',
      palette: {
        base00: '#fffdfb', base01: '#fff7ed', base02: '#f2e6d4', base03: '#bebebe',
        base04: '#8f8f8f', base05: '#636363', base06: '#303338', base07: '#24272b',
        base08: '#ca736c', base09: '#ba823a', base0A: '#8d9741', base0B: '#47a477',
        base0C: '#00a2af', base0D: '#5794d0', base0E: '#9481cc', base0F: '#bc73a4'
      }
    }
  },
  {
    id: 'primer-dark',
    scheme: {
      name: 'Primer Dark',
      author: 'Jimmy Lin',
      variant: 'dark',
      palette: {
        base00: '#010409', base01: '#21262d', base02: '#30363d', base03: '#484f58',
        base04: '#8b949e', base05: '#b1bac4', base06: '#c9d1d9', base07: '#f0f6fc',
        base08: '#ff7b72', base09: '#f0883e', base0A: '#d29922', base0B: '#3fb950',
        base0C: '#a5d6ff', base0D: '#58a6ff', base0E: '#f778ba', base0F: '#bd561d'
      }
    }
  },
  {
    id: 'primer-light',
    scheme: {
      name: 'Primer Light',
      author: 'Jimmy Lin',
      variant: 'light',
      palette: {
        base00: '#fafbfc', base01: '#e1e4e8', base02: '#d1d5da', base03: '#959da5',
        base04: '#444d56', base05: '#2f363d', base06: '#24292e', base07: '#1b1f23',
        base08: '#d73a49', base09: '#f66a0a', base0A: '#ffd33d', base0B: '#28a745',
        base0C: '#79b8ff', base0D: '#0366d6', base0E: '#ea4aaa', base0F: '#a04100'
      }
    }
  },
  {
    id: 'selenized-dark',
    scheme: {
      name: 'selenized-dark',
      author: 'Jan Warchol (https://github.com/jan-warchol/selenized) / adapted to base16 by ali',
      variant: 'dark',
      palette: {
        base00: '#103c48', base01: '#184956', base02: '#2d5b69', base03: '#72898f',
        base04: '#72898f', base05: '#adbcbc', base06: '#cad8d9', base07: '#cad8d9',
        base08: '#fa5750', base09: '#ed8649', base0A: '#dbb32d', base0B: '#75b938',
        base0C: '#41c7b9', base0D: '#4695f7', base0E: '#af88eb', base0F: '#f275be'
      }
    }
  },
  {
    id: 'selenized-light',
    scheme: {
      name: 'selenized-light',
      author: 'Jan Warchol (https://github.com/jan-warchol/selenized) / adapted to base16 by ali',
      variant: 'light',
      palette: {
        base00: '#fbf3db', base01: '#ece3cc', base02: '#d5cdb6', base03: '#909995',
        base04: '#909995', base05: '#53676d', base06: '#3a4d53', base07: '#3a4d53',
        base08: '#cc1729', base09: '#bc5819', base0A: '#a78300', base0B: '#428b00',
        base0C: '#00978a', base0D: '#006dce', base0E: '#825dc0', base0F: '#c44392'
      }
    }
  },
  {
    id: 'shadesmear-dark',
    scheme: {
      name: 'ShadeSmear Dark',
      author: 'Kyle Giammarco (http://kyle.giammar.co)',
      variant: 'dark',
      palette: {
        base00: '#232323', base01: '#1c1c1c', base02: '#4e4e4e', base03: '#c0c0c0',
        base04: '#e4e4e4', base05: '#dbdbdb', base06: '#e4e4e4', base07: '#1c1c1c',
        base08: '#cc5450', base09: '#a64270', base0A: '#307878', base0B: '#71983b',
        base0C: '#c57d42', base0D: '#376388', base0E: '#d7ab54', base0F: '#6d6d6d'
      }
    }
  },
  {
    id: 'shadesmear-light',
    scheme: {
      name: 'ShadeSmear Light',
      author: 'Kyle Giammarco (http://kyle.giammar.co)',
      variant: 'light',
      palette: {
        base00: '#dbdbdb', base01: '#e4e4e4', base02: '#c0c0c0', base03: '#4e4e4e',
        base04: '#1c1c1c', base05: '#232323', base06: '#1c1c1c', base07: '#e4e4e4',
        base08: '#cc5450', base09: '#a64270', base0A: '#307878', base0B: '#71983b',
        base0C: '#c57d42', base0D: '#376388', base0E: '#d7ab54', base0F: '#6d6d6d'
      }
    }
  },
  {
    id: 'solarflare',
    scheme: {
      name: 'Solar Flare',
      author: 'Chuck Harmston (https://chuck.harmston.ch)',
      variant: 'dark',
      palette: {
        base00: '#18262f', base01: '#222e38', base02: '#586875', base03: '#667581',
        base04: '#85939e', base05: '#a6afb8', base06: '#e8e9ed', base07: '#f5f7fa',
        base08: '#ef5253', base09: '#e66b2b', base0A: '#e4b51c', base0B: '#7cc844',
        base0C: '#52cbb0', base0D: '#33b5e1', base0E: '#a363d5', base0F: '#d73c9a'
      }
    }
  },
  {
    id: 'solarflare-light',
    scheme: {
      name: 'Solar Flare Light',
      author: 'Chuck Harmston (https://chuck.harmston.ch)',
      variant: 'light',
      palette: {
        base00: '#f5f7fa', base01: '#e8e9ed', base02: '#a6afb8', base03: '#85939e',
        base04: '#667581', base05: '#586875', base06: '#222e38', base07: '#18262f',
        base08: '#ef5253', base09: '#e66b2b', base0A: '#e4b51c', base0B: '#7cc844',
        base0C: '#52cbb0', base0D: '#33b5e1', base0E: '#a363d5', base0F: '#d73c9a'
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
    id: 'standardized-dark',
    scheme: {
      name: 'standardized-dark',
      author: 'ali (https://github.com/ali-githb/base16-standardized-scheme)',
      variant: 'dark',
      palette: {
        base00: '#222222', base01: '#303030', base02: '#555555', base03: '#898989',
        base04: '#898989', base05: '#c0c0c0', base06: '#e0e0e0', base07: '#ffffff',
        base08: '#e15d67', base09: '#fc804e', base0A: '#e1b31a', base0B: '#5db129',
        base0C: '#21c992', base0D: '#00a3f2', base0E: '#b46ee0', base0F: '#b87d28'
      }
    }
  },
  {
    id: 'standardized-light',
    scheme: {
      name: 'standardized-light',
      author: 'ali (https://github.com/ali-githb/base16-standardized-scheme)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#eeeeee', base02: '#cccccc', base03: '#767676',
        base04: '#767676', base05: '#444444', base06: '#333333', base07: '#222222',
        base08: '#d03e3e', base09: '#d7691d', base0A: '#ad8200', base0B: '#31861f',
        base0C: '#00998f', base0D: '#3173c5', base0E: '#9e57c2', base0F: '#895025'
      }
    }
  },
  {
    id: 'summerfruit-dark',
    scheme: {
      name: 'Summerfruit Dark',
      author: 'Christopher Corley (http://christop.club/)',
      variant: 'dark',
      palette: {
        base00: '#151515', base01: '#202020', base02: '#303030', base03: '#505050',
        base04: '#b0b0b0', base05: '#d0d0d0', base06: '#e0e0e0', base07: '#ffffff',
        base08: '#ff0086', base09: '#fd8900', base0A: '#aba800', base0B: '#00c918',
        base0C: '#1faaaa', base0D: '#3777e6', base0E: '#ad00a1', base0F: '#cc6633'
      }
    }
  },
  {
    id: 'summerfruit-light',
    scheme: {
      name: 'Summerfruit Light',
      author: 'Christopher Corley (http://christop.club/)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#e0e0e0', base02: '#d0d0d0', base03: '#b0b0b0',
        base04: '#000000', base05: '#101010', base06: '#151515', base07: '#202020',
        base08: '#ff0086', base09: '#fd8900', base0A: '#aba800', base0B: '#00c918',
        base0C: '#1faaaa', base0D: '#3777e6', base0E: '#ad00a1', base0F: '#cc6633'
      }
    }
  },
  {
    id: 'swamp-dark',
    scheme: {
      name: 'Swamp Dark',
      author: 'Masroof Maindak (https://github.com/masroof-maindak)',
      variant: 'dark',
      palette: {
        base00: '#242015', base01: '#3a3124', base02: '#4d3f32', base03: '#5f4e41',
        base04: '#b8a58c', base05: '#d2c3a4', base06: '#ebe0bb', base07: '#f1e9d0',
        base08: '#db930d', base09: '#ebe0bb', base0A: '#a82d56', base0B: '#7a7653',
        base0C: '#db930d', base0D: '#c1666b', base0E: '#91506c', base0F: '#61a0a8'
      }
    }
  },
  {
    id: 'swamp-light',
    scheme: {
      name: 'Swamp Light',
      author: 'Masroof Maindak (https://github.com/masroof-maindak)',
      variant: 'light',
      palette: {
        base00: '#f1e3d1', base01: '#ddcebc', base02: '#c9b9a7', base03: '#b5a492',
        base04: '#a0907d', base05: '#64513e', base06: '#786653', base07: '#8c7b68',
        base08: '#d09700', base09: '#64513e', base0A: '#993333', base0B: '#908d6a',
        base0C: '#d09700', base0D: '#bf7979', base0E: '#9e5581', base0F: '#75858c'
      }
    }
  },
  {
    id: 'synth-midnight-dark',
    scheme: {
      name: 'Synth Midnight Terminal Dark',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'dark',
      palette: {
        base00: '#050608', base01: '#1a1b1c', base02: '#28292a', base03: '#474849',
        base04: '#a3a5a6', base05: '#c1c3c4', base06: '#cfd1d2', base07: '#dddfe0',
        base08: '#b53b50', base09: '#ea770d', base0A: '#c9d364', base0B: '#06ea61',
        base0C: '#42fff9', base0D: '#03aeff', base0E: '#ea5ce2', base0F: '#cd6320'
      }
    }
  },
  {
    id: 'synth-midnight-light',
    scheme: {
      name: 'Synth Midnight Terminal Light',
      author: 'Michaël Ball (http://github.com/michael-ball/)',
      variant: 'light',
      palette: {
        base00: '#dddfe0', base01: '#cfd1d2', base02: '#c1c3c4', base03: '#a3a5a6',
        base04: '#474849', base05: '#28292a', base06: '#1a1b1c', base07: '#050608',
        base08: '#b53b50', base09: '#ea770d', base0A: '#c9d364', base0B: '#06ea61',
        base0C: '#42fff9', base0D: '#03aeff', base0E: '#ea5ce2', base0F: '#cd6320'
      }
    }
  },
  {
    id: 'terracotta',
    scheme: {
      name: 'Terracotta',
      author: 'Alexander Rossell Hayes (https://github.com/rossellhayes)',
      variant: 'light',
      palette: {
        base00: '#efeae8', base01: '#dfd6d1', base02: '#d0c1bb', base03: '#c0aca4',
        base04: '#59453d', base05: '#473731', base06: '#352a25', base07: '#241c19',
        base08: '#a75045', base09: '#bd6942', base0A: '#ce943e', base0B: '#7a894a',
        base0C: '#847f9e', base0D: '#625574', base0E: '#8d5968', base0F: '#b07158'
      }
    }
  },
  {
    id: 'terracotta-dark',
    scheme: {
      name: 'Terracotta Dark',
      author: 'Alexander Rossell Hayes (https://github.com/rossellhayes)',
      variant: 'dark',
      palette: {
        base00: '#241d1a', base01: '#362b27', base02: '#473933', base03: '#594740',
        base04: '#a78e84', base05: '#b8a59d', base06: '#cabbb5', base07: '#dcd2ce',
        base08: '#f6998f', base09: '#ffa888', base0A: '#ffc37a', base0B: '#b6c68a',
        base0C: '#c0bcdb', base0D: '#b0a4c3', base0E: '#d8a2b0', base0F: '#f1ae97'
      }
    }
  },
  {
    id: 'tokyo-city-dark',
    scheme: {
      name: 'Tokyo City Dark',
      author: 'Michaël Ball',
      variant: 'dark',
      palette: {
        base00: '#171d23', base01: '#1d252c', base02: '#28323a', base03: '#526270',
        base04: '#b7c5d3', base05: '#d8e2ec', base06: '#f6f6f8', base07: '#fbfbfd',
        base08: '#f7768e', base09: '#ff9e64', base0A: '#b7c5d3', base0B: '#9ece6a',
        base0C: '#89ddff', base0D: '#7aa2f7', base0E: '#bb9af7', base0F: '#bb9af7'
      }
    }
  },
  {
    id: 'tokyo-city-light',
    scheme: {
      name: 'Tokyo City Light',
      author: 'Michaël Ball',
      variant: 'light',
      palette: {
        base00: '#fbfbfd', base01: '#f6f6f8', base02: '#edeff6', base03: '#9699a3',
        base04: '#4c505e', base05: '#343b59', base06: '#1d252c', base07: '#171d23',
        base08: '#8c4351', base09: '#965027', base0A: '#4c505e', base0B: '#485e30',
        base0C: '#4c505e', base0D: '#34548a', base0E: '#5a4a78', base0F: '#5a4a78'
      }
    }
  },
  {
    id: 'tokyo-city-terminal-dark',
    scheme: {
      name: 'Tokyo City Terminal Dark',
      author: 'Michaël Ball',
      variant: 'dark',
      palette: {
        base00: '#171d23', base01: '#1d252c', base02: '#28323a', base03: '#526270',
        base04: '#b7c5d3', base05: '#d8e2ec', base06: '#f6f6f8', base07: '#fbfbfd',
        base08: '#d95468', base09: '#ff9e64', base0A: '#ebbf83', base0B: '#8bd49c',
        base0C: '#70e1e8', base0D: '#539afc', base0E: '#b62d65', base0F: '#dd9d82'
      }
    }
  },
  {
    id: 'tokyo-city-terminal-light',
    scheme: {
      name: 'Tokyo City Terminal Light',
      author: 'Michaël Ball',
      variant: 'light',
      palette: {
        base00: '#fbfbfd', base01: '#f6f6f8', base02: '#d8e2ec', base03: '#b7c5d3',
        base04: '#526270', base05: '#28323a', base06: '#1d252c', base07: '#171d23',
        base08: '#8c4351', base09: '#965027', base0A: '#8f5e15', base0B: '#33635c',
        base0C: '#0f4b6e', base0D: '#34548a', base0E: '#5a4a78', base0F: '#7e5140'
      }
    }
  },
  {
    id: 'tokyo-night-dark',
    scheme: {
      name: 'Tokyo Night Dark',
      author: 'Michaël Ball',
      variant: 'dark',
      palette: {
        base00: '#1a1b26', base01: '#16161e', base02: '#2f3549', base03: '#444b6a',
        base04: '#787c99', base05: '#a9b1d6', base06: '#cbccd1', base07: '#d5d6db',
        base08: '#c0caf5', base09: '#a9b1d6', base0A: '#0db9d7', base0B: '#9ece6a',
        base0C: '#b4f9f8', base0D: '#2ac3de', base0E: '#bb9af7', base0F: '#f7768e'
      }
    }
  },
  {
    id: 'tokyo-night-light',
    scheme: {
      name: 'Tokyo Night Light',
      author: 'Michaël Ball',
      variant: 'light',
      palette: {
        base00: '#d5d6db', base01: '#cbccd1', base02: '#dfe0e5', base03: '#9699a3',
        base04: '#4c505e', base05: '#343b59', base06: '#1a1b26', base07: '#1a1b26',
        base08: '#343b58', base09: '#965027', base0A: '#166775', base0B: '#485e30',
        base0C: '#3e6968', base0D: '#34548a', base0E: '#5a4a78', base0F: '#8c4351'
      }
    }
  },
  {
    id: 'tokyo-night-terminal-dark',
    scheme: {
      name: 'Tokyo Night Terminal Dark',
      author: 'Michaël Ball',
      variant: 'dark',
      palette: {
        base00: '#16161e', base01: '#1a1b26', base02: '#2f3549', base03: '#444b6a',
        base04: '#787c99', base05: '#787c99', base06: '#cbccd1', base07: '#d5d6db',
        base08: '#f7768e', base09: '#ff9e64', base0A: '#e0af68', base0B: '#41a6b5',
        base0C: '#7dcfff', base0D: '#7aa2f7', base0E: '#bb9af7', base0F: '#d18616'
      }
    }
  },
  {
    id: 'tokyo-night-terminal-light',
    scheme: {
      name: 'Tokyo Night Terminal Light',
      author: 'Michaël Ball',
      variant: 'light',
      palette: {
        base00: '#d5d6db', base01: '#cbccd1', base02: '#dfe0e5', base03: '#9699a3',
        base04: '#4c505e', base05: '#4c505e', base06: '#1a1b26', base07: '#1a1b26',
        base08: '#8c4351', base09: '#965027', base0A: '#8f5e15', base0B: '#33635c',
        base0C: '#0f4b6e', base0D: '#34548a', base0E: '#5a4a78', base0F: '#655259'
      }
    }
  },
  {
    id: 'windows-95',
    scheme: {
      name: 'Windows 95',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'dark',
      palette: {
        base00: '#000000', base01: '#1c1c1c', base02: '#383838', base03: '#545454',
        base04: '#7e7e7e', base05: '#a8a8a8', base06: '#d2d2d2', base07: '#fcfcfc',
        base08: '#fc5454', base09: '#a85400', base0A: '#fcfc54', base0B: '#54fc54',
        base0C: '#54fcfc', base0D: '#5454fc', base0E: '#fc54fc', base0F: '#00a800'
      }
    }
  },
  {
    id: 'windows-95-light',
    scheme: {
      name: 'Windows 95 Light',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'light',
      palette: {
        base00: '#fcfcfc', base01: '#e0e0e0', base02: '#c4c4c4', base03: '#a8a8a8',
        base04: '#7e7e7e', base05: '#545454', base06: '#2a2a2a', base07: '#000000',
        base08: '#a80000', base09: '#fcfc54', base0A: '#a85400', base0B: '#00a800',
        base0C: '#00a8a8', base0D: '#0000a8', base0E: '#a800a8', base0F: '#54fc54'
      }
    }
  },
  {
    id: 'windows-highcontrast',
    scheme: {
      name: 'Windows High Contrast',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'dark',
      palette: {
        base00: '#000000', base01: '#1c1c1c', base02: '#383838', base03: '#545454',
        base04: '#a2a2a2', base05: '#c0c0c0', base06: '#dedede', base07: '#fcfcfc',
        base08: '#fc5454', base09: '#808000', base0A: '#fcfc54', base0B: '#54fc54',
        base0C: '#54fcfc', base0D: '#5454fc', base0E: '#fc54fc', base0F: '#008000'
      }
    }
  },
  {
    id: 'windows-highcontrast-light',
    scheme: {
      name: 'Windows High Contrast Light',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'light',
      palette: {
        base00: '#fcfcfc', base01: '#e8e8e8', base02: '#d4d4d4', base03: '#c0c0c0',
        base04: '#7e7e7e', base05: '#545454', base06: '#2a2a2a', base07: '#000000',
        base08: '#800000', base09: '#fcfc54', base0A: '#808000', base0B: '#008000',
        base0C: '#008080', base0D: '#000080', base0E: '#800080', base0F: '#54fc54'
      }
    }
  },
  {
    id: 'windows-nt',
    scheme: {
      name: 'Windows NT',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'dark',
      palette: {
        base00: '#000000', base01: '#2a2a2a', base02: '#555555', base03: '#808080',
        base04: '#a1a1a1', base05: '#c0c0c0', base06: '#e0e0e0', base07: '#ffffff',
        base08: '#ff0000', base09: '#808000', base0A: '#ffff00', base0B: '#00ff00',
        base0C: '#00ffff', base0D: '#0000ff', base0E: '#ff00ff', base0F: '#008000'
      }
    }
  },
  {
    id: 'windows-nt-light',
    scheme: {
      name: 'Windows NT Light',
      author: 'Fergus Collins (https://github.com/ferguscollins)',
      variant: 'light',
      palette: {
        base00: '#ffffff', base01: '#eaeaea', base02: '#d5d5d5', base03: '#c0c0c0',
        base04: '#a0a0a0', base05: '#808080', base06: '#404040', base07: '#000000',
        base08: '#800000', base09: '#ffff00', base0A: '#808000', base0B: '#008000',
        base0C: '#008080', base0D: '#000080', base0E: '#800080', base0F: '#00ff00'
      }
    }
  }
];

/** 53 个族。预设轴选它，模式轴再决定取哪一边。 */
export const BASE16_PRESETS: readonly BuiltInPreset[] = [
  { id: 'arroz-con-dulce', name: 'Arroz Con Dulce', variants: { light: 'arroz-con-dulce', dark: 'arroz-con-dulce-dark' } },
  { id: 'atelier-cave', name: 'Atelier Cave', variants: { light: 'atelier-cave-light', dark: 'atelier-cave' } },
  { id: 'atelier-estuary', name: 'Atelier Estuary', variants: { light: 'atelier-estuary-light', dark: 'atelier-estuary' } },
  { id: 'atelier-forest', name: 'Atelier Forest', variants: { light: 'atelier-forest-light', dark: 'atelier-forest' } },
  { id: 'atelier-heath', name: 'Atelier Heath', variants: { light: 'atelier-heath-light', dark: 'atelier-heath' } },
  { id: 'atelier-lakeside', name: 'Atelier Lakeside', variants: { light: 'atelier-lakeside-light', dark: 'atelier-lakeside' } },
  { id: 'atelier-plateau', name: 'Atelier Plateau', variants: { light: 'atelier-plateau-light', dark: 'atelier-plateau' } },
  { id: 'atelier-savanna', name: 'Atelier Savanna', variants: { light: 'atelier-savanna-light', dark: 'atelier-savanna' } },
  { id: 'atelier-seaside', name: 'Atelier Seaside', variants: { light: 'atelier-seaside-light', dark: 'atelier-seaside' } },
  { id: 'atelier-sulphurpool', name: 'Atelier Sulphurpool', variants: { light: 'atelier-sulphurpool-light', dark: 'atelier-sulphurpool' } },
  { id: 'cerulean-signal', name: 'Cerulean Signal', variants: { light: 'cerulean-signal-light', dark: 'cerulean-signal-dark' } },
  { id: 'charcoal', name: 'Charcoal', variants: { light: 'charcoal-light', dark: 'charcoal-dark' } },
  { id: 'classic', name: 'Classic', variants: { light: 'classic-light', dark: 'classic-dark' } },
  { id: 'danqing', name: 'Danqing', variants: { light: 'danqing-light', dark: 'danqing' } },
  { id: 'default', name: 'Default', variants: { light: 'default-light', dark: 'default-dark' } },
  { id: 'dracula', name: 'Dracula', variants: { dark: 'dracula' } },
  { id: 'embers', name: 'Embers', variants: { light: 'embers-light', dark: 'embers' } },
  { id: 'equilibrium', name: 'Equilibrium', variants: { light: 'equilibrium-light', dark: 'equilibrium-dark' } },
  { id: 'equilibrium-gray', name: 'Equilibrium Gray', variants: { light: 'equilibrium-gray-light', dark: 'equilibrium-gray-dark' } },
  { id: 'flexoki', name: 'Flexoki', variants: { light: 'flexoki-light', dark: 'flexoki-dark' } },
  { id: 'github', name: 'Github', variants: { light: 'github', dark: 'github-dark' } },
  { id: 'google', name: 'Google', variants: { light: 'google-light', dark: 'google-dark' } },
  { id: 'grayscale', name: 'Grayscale', variants: { light: 'grayscale-light', dark: 'grayscale-dark' } },
  { id: 'gruvbox', name: 'Gruvbox', variants: { light: 'gruvbox-light', dark: 'gruvbox-dark' } },
  { id: 'heetch', name: 'Heetch', variants: { light: 'heetch-light', dark: 'heetch' } },
  { id: 'horizon', name: 'Horizon', variants: { light: 'horizon-light', dark: 'horizon-dark' } },
  { id: 'horizon-terminal', name: 'Horizon Terminal', variants: { light: 'horizon-terminal-light', dark: 'horizon-terminal-dark' } },
  { id: 'humanoid', name: 'Humanoid', variants: { light: 'humanoid-light', dark: 'humanoid-dark' } },
  { id: 'ia', name: 'Ia', variants: { light: 'ia-light', dark: 'ia-dark' } },
  { id: 'lichen-chartreuse', name: 'Lichen Chartreuse', variants: { light: 'lichen-chartreuse-light', dark: 'lichen-chartreuse-dark' } },
  { id: 'measured', name: 'Measured', variants: { light: 'measured-light', dark: 'measured-dark' } },
  { id: 'neovim', name: 'Neovim', variants: { light: 'neovim-light', dark: 'neovim-dark' } },
  { id: 'nord', name: 'Nord', variants: { light: 'nord-light', dark: 'nord' } },
  { id: 'papercolor', name: 'Papercolor', variants: { light: 'papercolor-light', dark: 'papercolor-dark' } },
  { id: 'pastelon-de-amarillos', name: 'Pastelon De Amarillos', variants: { light: 'pastelon-de-amarillos', dark: 'pastelon-de-amarillos-dark' } },
  { id: 'penumbra', name: 'Penumbra', variants: { light: 'penumbra-light', dark: 'penumbra-dark' } },
  { id: 'primer', name: 'Primer', variants: { light: 'primer-light', dark: 'primer-dark' } },
  { id: 'selenized', name: 'Selenized', variants: { light: 'selenized-light', dark: 'selenized-dark' } },
  { id: 'shadesmear', name: 'Shadesmear', variants: { light: 'shadesmear-light', dark: 'shadesmear-dark' } },
  { id: 'solarflare', name: 'Solarflare', variants: { light: 'solarflare-light', dark: 'solarflare' } },
  { id: 'solarized', name: 'Solarized', variants: { light: 'solarized-light', dark: 'solarized-dark' } },
  { id: 'standardized', name: 'Standardized', variants: { light: 'standardized-light', dark: 'standardized-dark' } },
  { id: 'summerfruit', name: 'Summerfruit', variants: { light: 'summerfruit-light', dark: 'summerfruit-dark' } },
  { id: 'swamp', name: 'Swamp', variants: { light: 'swamp-light', dark: 'swamp-dark' } },
  { id: 'synth-midnight', name: 'Synth Midnight', variants: { light: 'synth-midnight-light', dark: 'synth-midnight-dark' } },
  { id: 'terracotta', name: 'Terracotta', variants: { light: 'terracotta', dark: 'terracotta-dark' } },
  { id: 'tokyo-city', name: 'Tokyo City', variants: { light: 'tokyo-city-light', dark: 'tokyo-city-dark' } },
  { id: 'tokyo-city-terminal', name: 'Tokyo City Terminal', variants: { light: 'tokyo-city-terminal-light', dark: 'tokyo-city-terminal-dark' } },
  { id: 'tokyo-night', name: 'Tokyo Night', variants: { light: 'tokyo-night-light', dark: 'tokyo-night-dark' } },
  { id: 'tokyo-night-terminal', name: 'Tokyo Night Terminal', variants: { light: 'tokyo-night-terminal-light', dark: 'tokyo-night-terminal-dark' } },
  { id: 'windows-95', name: 'Windows 95', variants: { light: 'windows-95-light', dark: 'windows-95' } },
  { id: 'windows-highcontrast', name: 'Windows Highcontrast', variants: { light: 'windows-highcontrast-light', dark: 'windows-highcontrast' } },
  { id: 'windows-nt', name: 'Windows Nt', variants: { light: 'windows-nt-light', dark: 'windows-nt' } }
];
