import { mergeConfig } from "vitest/config";
import { baseTestConfig } from "../../vitest.config.base";

/**
 * The mobile app's automated tests target the framework-agnostic domain layer
 * (identity/crypto, key recovery, disclaimer gate, preferred-name, and the
 * Zustand store slices through their pure reducers). These run under Node just
 * like every other Kshema package; the React Native UI is exercised via Expo
 * tooling outside this runner.
 *
 * `esbuild.tsconfigRaw` overrides tsconfck's default of loading the app
 * `tsconfig.json` (which `extends "expo/tsconfig.base"` — only resolvable with
 * the Expo SDK installed). The domain tests need no special compiler options,
 * so an empty config keeps esbuild from touching the Expo-based tsconfig.
 */
export default mergeConfig(baseTestConfig, {
  esbuild: {
    tsconfigRaw: "{}",
  },
});
