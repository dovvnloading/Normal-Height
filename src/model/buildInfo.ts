/** Build provenance is data only; loading a project never executes git. */
export interface BuildInfo {
  revision: string;
  dirty: boolean | null;
  source: 'git' | 'unknown';
}

declare const __NH_BUILD_INFO__: BuildInfo | undefined;

/** Vite injects this at build time; standalone tests/tools have an honest fallback. */
export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze(
  typeof __NH_BUILD_INFO__ === 'undefined'
    ? { revision: 'unknown', dirty: null, source: 'unknown' }
    : { ...__NH_BUILD_INFO__ },
);
