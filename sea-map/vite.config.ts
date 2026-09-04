import legacy from '@vitejs/plugin-legacy';
import { defineConfig } from 'vite';
import { wrgDemoPlugin } from './vite-wrg-demo-plugin';

export default defineConfig({
  base: './',
  plugins: [
    wrgDemoPlugin(),
    legacy({
      // Desktop + phones / WebViews. IE 11 is intentionally out of scope.
      targets: [
        'defaults',
        '> 0.2%',
        'iOS >= 12',
        'Android >= 7',
        'Samsung >= 12',
        'not IE 11',
        'not dead',
      ],
      // Polyfill modern ESM browsers that still miss newer builtins.
      modernPolyfills: true,
      // Keep modern chunk reachable for Safari 14 / older Chrome Android too.
      modernTargets: [
        'edge>=88',
        'firefox>=78',
        'chrome>=87',
        'safari>=14',
        'chromeAndroid>=87',
        'iOS>=14',
        'samsung>=14',
      ],
    }),
  ],
  build: {
    chunkSizeWarningLimit: 2000,
    cssTarget: ['chrome87', 'safari14', 'firefox78', 'edge88'],
  },
  preview: {
    allowedHosts: true,
    // Vite's default CORS allowlist is localhost-only. Production module
    // scripts are emitted with `crossorigin`, so a public tunnel Origin
    // (lhr.life / trycloudflare / serveo) gets no ACAO and Safari / Yandex
    // refuse to execute the bundle — the boot fallback then looks like an
    // "unsupported browser". Reflect any Origin on preview + dev.
    cors: { origin: true },
  },
  server: {
    allowedHosts: true,
    cors: { origin: true },
  },
});
