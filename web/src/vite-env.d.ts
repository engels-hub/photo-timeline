/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRIP_PASSWORD?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
