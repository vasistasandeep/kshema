#!/usr/bin/env tsx
/**
 * CLI: fail the build on any Banned_Term in user-facing source strings.
 *
 * Usage:  tsx <this> [root ...]
 * Defaults to scanning the current working directory. Exits non-zero (and
 * prints each violation) when any Banned_Term is found, enforcing the
 * Brand_Lexicon repo-wide even without ESLint installed (R28.18, R30.8).
 */
import { scanRoots } from "../src/scan-banned-terms.js";

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : [process.cwd()];

const violations = scanRoots(targets);

if (violations.length === 0) {
  console.log(`no-banned-terms: OK — scanned ${targets.join(", ")}, no Banned_Term found.`);
  process.exit(0);
}

console.error(`no-banned-terms: FAILED — ${violations.length} Banned_Term violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  Banned_Term "${v.term}"  →  ${v.snippet}`);
}
console.error("\nUse an approved Brand_Lexicon term instead. See packages/config/src/rules/no-banned-terms.ts.");
process.exit(1);
