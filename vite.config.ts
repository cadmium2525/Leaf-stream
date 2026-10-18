import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages では BASE_PATH=/Leaf-stream/ でビルドする
  base: process.env.BASE_PATH || '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
