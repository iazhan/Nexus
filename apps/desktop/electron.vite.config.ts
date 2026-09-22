import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

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
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'renderer/index.html')
          }
        }
      }
    }
  };
});
