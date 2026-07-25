import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1500,
  },
  preview: {
    allowedHosts: true,
  },
  server: {
    allowedHosts: true,
  },
});
