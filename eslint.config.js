import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.serena/**',
      // 本目录是工程数据与 agent 的临时脚本（探针、一次性改写脚本），已 gitignore，
      // 不是产品源码。不排除的话 `eslint .` 会被几十个 .mjs 探针脚本刷屏，
      // 把真正的 5 条错误淹掉。
      '.workbuddy-ai/**',
      'docs/**'
    ]
  },
  {
    // Node ESM 工具脚本。glob 必须写 `**/scripts/`，不能只写 `scripts/` ——
    // `packages/theme/scripts/` 下的四个脚本（主题门禁、静态 CSS 生成、dump）同样吃
    // js.configs.recommended 的 no-undef，而仓库没有装 globals 包，不显式声明的话
    // console / process 会被报成一堆错误（2026-09-29 修）。
    files: ['scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
);
