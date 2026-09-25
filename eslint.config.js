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
