import { defineConfig } from "vitest/config";

/**
 * Web app unit tests. These cover framework-agnostic browser logic that runs
 * without a full Next.js/DOM toolchain: the Web_Crypto_Vault (SubtleCrypto,
 * available as `globalThis.crypto` in Node 20+) and the idle-lock timer, plus
 * the public brand & trust portal content (i18n catalogs, Banned_Term guard,
 * escalation-ladder model, and localized pricing/currency detection — R30).
 * React component / SSE integration coverage requires a browser runtime and
 * is exercised via the Next.js build + manual/e2e testing.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["lib/**/*.{test,spec}.ts", "content/**/*.{test,spec}.ts"],
  },
});
