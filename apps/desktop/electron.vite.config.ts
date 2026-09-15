import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  const resolveConfig = isDev
    ? {
        alias: {
          '@nexus/core': resolve(__dirname, '../../packages/core/src/index.ts'),
          '@nexus/editor': resolve(__dirname, '../../packages/editor/src/index.ts')
        }
      }
    : undefined;

  return {
    main: {
      resolve: resolveConfig,
      plugins: [
        externalizeDepsPlugin({
          exclude: ['@nexus/core', '@nexus/editor']
        })
      ],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'electron/index.ts')
          }
        }
      }
    },
    preload: {
      resolve: resolveConfig,
      plugins: [
        externalizeDepsPlugin({
          exclude: ['@nexus/core', '@nexus/editor']
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
