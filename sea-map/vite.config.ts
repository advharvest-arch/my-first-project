import legacy from '@vitejs/plugin-legacy';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [
    legacy({
      // Broad device coverage: desktop + iOS/Android WebViews (not IE 11).
      targets: ['defaults', 'iOS >= 12', 'Android >= 7', 'not IE 11'],
      // ESM browsers that still miss newer builtins get polyfills too.
      modernPolyfills: true,
      modernTargets: [
        'edge>=90',
        'firefox>=90',
        'chrome>=90',
        'safari>=14',
        'chromeAndroid>=90',
        'iOS>=14',
      ],
    }),
  ],
  build: {
    chunkSizeWarningLimit: 2000,
  },
  preview: {
    allowedHosts: true,
  },
  server: {
    allowedHosts: true,
  },
});
