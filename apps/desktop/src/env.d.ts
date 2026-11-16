/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Omni server a hosted build opens. Empty in a self-hosted build: the picker asks. */
  readonly OMNI_DESKTOP_ORIGIN?: string;
}
