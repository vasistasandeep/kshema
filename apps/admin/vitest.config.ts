import { defineConfig } from "vitest/config";

/**
 * Admin console unit tests. These cover framework-agnostic logic that runs
 * without a full Next.js/DOM toolchain: the single-role RBAC capability map
 * (mirrored from the server guard) and the admin token decode. React component
 * / live-SSE coverage requires a browser runtime and is exercised via the
 * Next.js build + manual/e2e testing.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["lib/**/*.{test,spec}.ts"],
  },
});
