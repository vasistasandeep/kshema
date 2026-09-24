/**
 * Repo-wide Banned_Term enforcement for `apps/web` (R30.8, R28.18).
 *
 * Runs the shared `@kshema/config` scanner over this app's ENTIRE source tree,
 * enforcing the same Brand_Lexicon and the same bounded philosophy-tenet
 * exceptions as the custom `no-banned-terms` ESLint rule — but using only
 * vitest (already this app's test runner), so the "fail the build on any
 * violation" guarantee holds even though ESLint / eslint-config-next are not
 * installed in this environment. Lives under `content/` so the app's scoped
 * vitest `include` picks it up; wired into the app's `lint` script.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRoots } from "@kshema/config/scan";

// content/ -> app root
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("apps/web contains no Banned_Term in user-facing strings", () => {
  it("passes the Brand_Lexicon guard across the whole app", () => {
    const violations = scanRoots([appRoot]);
    expect(
      violations,
      violations.map((v) => `${v.file}:${v.line} "${v.term}" -> ${v.snippet}`).join("\n"),
    ).toHaveLength(0);
  });
});
