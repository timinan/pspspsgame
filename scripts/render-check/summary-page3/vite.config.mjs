import { defineConfig } from 'vite';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@': path.resolve(repoRoot, 'src/client') },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
