import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('./web/', import.meta.url));
const dependencies = fileURLToPath(new URL('./node_modules/', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    fs: { allow: [webRoot, dependencies] },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
