import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  // The record editor loads lazily; bundling its packages up front keeps the dev server from re-optimizing mid-session.
  optimizeDeps: {
    include: [
      '@tiptap/react', '@tiptap/starter-kit', '@tiptap/markdown', '@tiptap/extension-image', '@tiptap/extension-list',
      '@tiptap/extension-table', '@tiptap/extensions',
    ],
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: 'es2022' },
});
