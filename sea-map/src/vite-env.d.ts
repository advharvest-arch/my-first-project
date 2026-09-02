/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional CARTO basemaps key — public, injected at build time. Never commit a real value. */
  readonly VITE_CARTO_API_KEY?: string;
  /**
   * Yandex Maps JS API v3 key for sea-map/yandex-proto only.
   * Never commit a real value — use .env.local or CI secrets.
   */
  readonly VITE_YANDEX_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.json' {
  const value: unknown;
  export default value;
}
