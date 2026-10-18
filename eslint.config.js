import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'supabase/functions/_shared/sim-core'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', localStorage: 'readonly',
        Deno: 'readonly', Response: 'readonly', Request: 'readonly', crypto: 'readonly',
        process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/sim-core/**/*.ts'],
    rules: {
      // 決定論性のため、エンジン依存の超越関数・乱数・時刻を禁止
      'no-restricted-properties': ['error',
        ...['sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'pow', 'random', 'hypot', 'cbrt', 'asin', 'acos'].map((p) => ({
          object: 'Math', property: p, message: 'sim-core では決定論性のため使用禁止（+ - * / sqrt のみ）',
        })),
      ],
      'no-restricted-globals': ['error', 'Date', 'performance'],
    },
  },
);
