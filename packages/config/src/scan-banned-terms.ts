/**
 * @kshema/config — dependency-free Banned_Term source scanner.
 *
 * The custom `no-banned-terms` ESLint rule (see ./rules/no-banned-terms) is the
 * primary static enforcement mechanism and runs under `next lint` / ESLint once
 * those dev dependencies are installed. This scanner is a lightweight, Node-only
 * companion that enforces the SAME Banned_Term lexicon and the SAME bounded
 * philosophy-tenet exceptions WITHOUT requiring ESLint to be present — so the
 * repo-wide build-fails-on-violation guarantee (R30.8, R28.18) holds even in a
 * toolchain where ESLint has not yet been installed.
 *
 * It scans string/JSX-ish text occurrences in source files and reports any
 * Banned_Term. Detection intentionally mirrors {@link findBannedTerm} and the
 * key-scoped exception semantics of the ESLint rule.
 *
 * Requirements: 16.1, 16.4, 17.4, 28.18, 30.8.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  DEFAULT_BANNED_TERMS,
  findBannedTerm,
} from "./rules/no-banned-terms.js";
import { SANCTIONED_TERM_EXCEPTIONS } from "./eslint.js";

/** A single Banned_Term violation. */
export interface BannedTermViolation {
  readonly file: string;
  readonly line: number;
  readonly term: string;
  readonly snippet: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".expo",
]);

/**
 * Files excluded from the user-facing-string scan. The rule targets *rendered*
 * UI copy, so test fixtures and the Banned_Term guard/lexicon modules — which
 * intentionally enumerate the forbidden terms as data — are not UI strings and
 * are skipped. The ESLint rule likewise runs only over app source, and lint
 * configs conventionally ignore test files.
 */
function isExcludedFile(file: string): boolean {
  const name = basename(file);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  // Banned_Term guard / lexicon / scanner definition modules enumerate the
  // terms deliberately; they define the vocabulary rather than render it.
  if (name === "banned-terms.ts" || name === "banned-terms.tsx") return true;
  if (name === "scan-banned-terms.ts" || name === "no-banned-terms.ts") return true;
  return false;
}

/** String / JSX-text-ish literals: '...', "...", `...`, and >text<. */
const STRINGISH = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`|>([^<>{}]+)</g;

/**
 * Styling attributes whose string values are class/style tokens, not rendered
 * copy. Tailwind ships utilities like `tracking-wide` (letter-spacing) that
 * embed a Banned_Term substring but are never shown to a user. We skip string
 * literals that are the value of these attributes to avoid false positives.
 */
const STYLE_ATTR_BEFORE = /(?:className|class|style|classNames?|tw|cn)\s*=\s*$/;

/** Strips `// line` and block comments so comments are never scanned. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\r\n]*/g, (_m, p1) => p1);
}

/** Matches a sanctioned key appearing immediately before the value, e.g. `philosophy.heading:` or "philosophy.lede":. */
function sanctionedTermsForContext(before: string): readonly string[] {
  for (const key of Object.keys(SANCTIONED_TERM_EXCEPTIONS)) {
    // key as identifier or string-literal property immediately preceding a colon
    const re = new RegExp(`(?:["'\`]?)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:["'\`]?)\\s*:\\s*$`);
    if (re.test(before)) return SANCTIONED_TERM_EXCEPTIONS[key]!;
  }
  return [];
}

/** Scans a single file's contents for Banned_Term violations. */
export function scanContent(
  file: string,
  content: string,
  terms: readonly string[] = DEFAULT_BANNED_TERMS,
): BannedTermViolation[] {
  // Lexicon-definition modules declare a `BANNED_TERM(S)` constant and
  // intentionally enumerate the forbidden vocabulary as data — they define the
  // list rather than render it, so they are not user-facing copy.
  if (/\b(?:const|let|var|type|enum)\s+BANNED_TERMS?\b/.test(content)) {
    return [];
  }

  const violations: BannedTermViolation[] = [];
  const lines = stripComments(content).split(/\r?\n/);
  lines.forEach((line, idx) => {
    STRINGISH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRINGISH.exec(line)) !== null) {
      const text = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!text) continue;
      const before = line.slice(0, m.index);
      // Skip class/style token values (e.g. Tailwind `tracking-wide`).
      if (STYLE_ATTR_BEFORE.test(before)) continue;
      const allowed = sanctionedTermsForContext(before);
      const term = findBannedTerm(text, terms, allowed);
      if (term) {
        violations.push({ file, line: idx + 1, term, snippet: line.trim().slice(0, 160) });
      }
    }
  });
  return violations;
}

/** Recursively collects scannable source files under `dir`. */
export function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectSourceFiles(full, acc);
    } else if (
      SOURCE_EXTENSIONS.has(extname(entry)) &&
      !entry.endsWith(".d.ts") &&
      !isExcludedFile(full)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** Scans every source file under the given roots and returns all violations. */
export function scanRoots(roots: readonly string[]): BannedTermViolation[] {
  const violations: BannedTermViolation[] = [];
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      violations.push(...scanContent(file, readFileSync(file, "utf8")));
    }
  }
  return violations;
}
