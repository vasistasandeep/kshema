/**
 * @kshema/config — shared TypeScript base preset.
 *
 * This mirrors the repo-root `tsconfig.base.json` compiler options as a
 * typed object so tooling (and tests) can reference the canonical settings
 * programmatically. Package `tsconfig.json` files still `extends` the JSON
 * file directly; this export is the single source of truth for the intended
 * strictness contract shared by every app/package.
 */
export interface TsPreset {
  readonly target: string;
  readonly module: string;
  readonly moduleResolution: string;
  readonly strict: boolean;
  readonly noUncheckedIndexedAccess: boolean;
  readonly noImplicitOverride: boolean;
  readonly noFallthroughCasesInSwitch: boolean;
  readonly forceConsistentCasingInFileNames: boolean;
  readonly esModuleInterop: boolean;
  readonly isolatedModules: boolean;
  readonly skipLibCheck: boolean;
}

/**
 * The canonical strict TypeScript preset consumed by every app/package.
 * Kept in sync with `tsconfig.base.json` at the repo root.
 */
export const tsBaseConfig: TsPreset = {
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  forceConsistentCasingInFileNames: true,
  esModuleInterop: true,
  isolatedModules: true,
  skipLibCheck: true,
};

/** Relative specifier packages use in their `tsconfig.json` `extends` field. */
export const TS_BASE_EXTENDS = "../../tsconfig.base.json" as const;
