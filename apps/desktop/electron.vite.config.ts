import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * ## 打包相关的一条判据（动依赖时必读）
 *
 * `apps/desktop/package.json` 的 `dependencies` 里**只放打包后仍要从 node_modules 加载的包**：
 * mammoth / node-sqlite3-wasm / pdfjs-dist / electron-updater。
 *
 * `@nexus/*`、`react`、`react-dom`、`@fontsource-variable/*` 都是**构建期**依赖 ——
 * 它们连同整条依赖树（mermaid、katex、d3、codemirror…）在这里被打进 `out/`，
 * 所以放在 `devDependencies`。下面那份 `exclude` 列表是「谁必须被 bundle」的显式答案，
 * 与「谁不在 dependencies 里」目前重合，保留它是为了让这件事有一处写着的地方。
 *
 * 把那些包挪回 `dependencies` 的后果是**静默的**：electron-builder 会顺着依赖树把它们
 * 再收一遍进 asar（实测 34.8MB → 113MB），功能一切正常，只有安装包白白胖三倍。
 * 判据见 `apps/desktop/electron-builder.yml` 的头注释。
 */
export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  const resolveConfig = isDev
    ? {
        alias: {
          '@nexus/core': resolve(__dirname, '../../packages/core/src/index.ts'),
          '@nexus/theme': resolve(__dirname, '../../packages/theme/src/index.ts'),
          '@nexus/editor': resolve(__dirname, '../../packages/editor/src/index.ts'),
          '@nexus/command': resolve(__dirname, '../../packages/command/src/index.ts'),
          '@nexus/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
          '@nexus/markdown': resolve(__dirname, '../../packages/markdown/src/index.ts')
        }
      }
    : undefined;

  return {
    main: {
      resolve: resolveConfig,
      plugins: [
        externalizeDepsPlugin({
          exclude: [
            '@nexus/core',
            '@nexus/theme',
            '@nexus/editor',
            '@nexus/command',
            '@nexus/i18n',
            '@nexus/markdown'
          ]
        })
      ],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'electron/index.ts')
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs'
          }
        }
      }
    },
    preload: {
      resolve: resolveConfig,
      plugins: [
        externalizeDepsPlugin({
          exclude: [
            '@nexus/core',
            '@nexus/theme',
            '@nexus/editor',
            '@nexus/command',
            '@nexus/i18n',
            '@nexus/markdown'
          ]
        })
      ],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'preload/index.ts')
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs'
          }
        }
      }
    },
    renderer: {
      root: resolve(__dirname, 'renderer'),
      resolve: resolveConfig,
      server: {
        host: '127.0.0.1',
        port: 6200
      },
      optimizeDeps: {
        exclude: [
          '@nexus/core',
          '@nexus/theme',
          '@nexus/editor',
          '@nexus/command',
          '@nexus/i18n',
          '@nexus/markdown'
        ]
      },
      plugins: [react()],
      build: {
        // electron-vite 三个 target 的默认配置里都写了 `minify: false`（见
        // node_modules/electron-vite/dist/chunks/lib-*.mjs 里 renderer 的 defaultConfig），
        // 用意是让主进程 / 预加载脚本便于调试。但 renderer 是唯一有体积问题的产物：
        // 不压缩时入口块 2.3MB / 5.9 万行，中文注释原样保留。
        //
        // 显式覆盖回 Vite 自己的默认值 `'esbuild'`。`build.cssMinify` 的默认值是跟随
        // `build.minify` 的，所以这一条同时把 CSS 也压了（改前主 CSS 686 行、未压缩）。
        // 主进程 / 预加载不动：产物只有几 KB，压了收益为零，还会牺牲栈可读性。
        minify: 'esbuild',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'renderer/index.html')
          }
        }
      }
    }
  };
});
