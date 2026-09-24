import { defineConfig } from "vitest/config";

/**
 * Shared Vitest configuration for every Kshema app/package.
 * Individual packages extend this via `mergeConfig` in their own
 * `vitest.config.ts`, and the `test` task is wired through Turborepo.
 *
 * Property-based tests use `fast-check` at a minimum of 100 iterations
 * (see design "Property-based tests"); the runner is Vitest.
 */
export const baseTestConfig = defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});

export default baseTestConfig;
