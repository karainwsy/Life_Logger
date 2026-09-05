import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '../../');

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@life-logger/shared': path.resolve(rootDir, 'packages/shared/src/index.ts'),
      '@life-logger/domain': path.resolve(rootDir, 'packages/domain/src/index.ts'),
      '@life-logger/storage': path.resolve(rootDir, 'packages/storage/src/index.ts'),
      '@life-logger/capture': path.resolve(rootDir, 'packages/capture/src/index.ts'),
      '@life-logger/ai': path.resolve(rootDir, 'packages/ai/src/index.ts'),
      '@life-logger/sync': path.resolve(rootDir, 'packages/sync/src/index.ts')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    assetsInlineLimit: 0,
    outDir: 'dist'
  }
});
