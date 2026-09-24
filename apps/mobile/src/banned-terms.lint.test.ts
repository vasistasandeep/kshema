/**
 * Repo-wide Banned_Term enforcement for `apps/mobile` (R16.1, R17.4).
 *
 * Runs the shared `@kshema/config` scanner over this app's ENTIRE source tree,
 * enforcing the Brand_Lexicon (English terms + locale equivalents) with the
 * custom rule's semantics but using only vitest. Lives under `src/` so the
 * app's scoped vitest `include` picks it up; wired into the app's `lint`
 * script so any Banned_Term fails the build even though ESLint is not installed
 * in this environment.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRoots } from "@kshema/config/scan";

// src/ -> app root
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("apps/mobile contains no Banned_Term in user-facing strings", () => {
  it("passes the Brand_Lexicon guard across the whole app", () => {
    const violations = scanRoots([appRoot]);
    expect(
      violations,
      violations.map((v) => `${v.file}:${v.line} "${v.term}" -> ${v.snippet}`).join("\n"),
    ).toHaveLength(0);
  });
});
