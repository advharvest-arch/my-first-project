/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional CARTO basemaps key — public, injected at build time. Never commit a real value. */
  readonly VITE_CARTO_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.json' {
  const value: unknown;
  export default value;
}
