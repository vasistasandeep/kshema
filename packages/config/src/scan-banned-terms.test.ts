import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanContent, scanRoots } from "./scan-banned-terms";

const here = dirname(fileURLToPath(import.meta.url));
// packages/config/src -> repo root
const repoRoot = join(here, "..", "..", "..");

describe("scanContent detection", () => {
  it("flags a Banned_Term in a double-quoted string", () => {
    const v = scanContent("x.ts", 'const label = "24/7 Monitoring";');
    expect(v).toHaveLength(1);
    expect(v[0]!.term).toBe("monitoring");
  });

  it("flags a Banned_Term in JSX text", () => {
    const v = scanContent("x.tsx", "<p>Live Tracking enabled</p>");
    expect(v.some((x) => x.term === "tracking")).toBe(true);
  });

  it("flags a Banned_Term in a template literal", () => {
    const v = scanContent("x.ts", "const s = `press the Panic Button now`;");
    expect(v.some((x) => x.term === "panic button")).toBe(true);
  });

  it("flags a locale-equivalent Banned_Term", () => {
    const v = scanContent("x.ts", 'const s = "निगरानी सेवा";');
    expect(v.some((x) => x.term === "निगरानी")).toBe(true);
  });

  it("passes clean approved copy", () => {
    const v = scanContent("x.tsx", '<h1>All Well</h1>; const s = "gentle morning check-in";');
    expect(v).toHaveLength(0);
  });

  it("honors the philosophy.heading sanctioned exception", () => {
    const v = scanContent(
      "catalog.ts",
      '  "philosophy.heading": "Dignity Over Surveillance",',
    );
    expect(v).toHaveLength(0);
  });

  it("still flags a non-sanctioned term in a sanctioned key", () => {
    const v = scanContent(
      "catalog.ts",
      '  "philosophy.heading": "Surveillance and Panic Button",',
    );
    expect(v.some((x) => x.term === "panic button")).toBe(true);
  });

  it("does not leak the exception to a different key", () => {
    const v = scanContent("catalog.ts", '  "legal.terms": "we run surveillance",');
    expect(v.some((x) => x.term === "surveillance")).toBe(true);
  });
});

// Repo-wide enforcement: no app source may contain a Banned_Term (R28.18, R30.8).
describe("repo-wide Banned_Term enforcement across all apps", () => {
  it("apps/mobile, apps/admin, and apps/web contain no Banned_Term", () => {
    const roots = [
      join(repoRoot, "apps", "mobile"),
      join(repoRoot, "apps", "admin"),
      join(repoRoot, "apps", "web"),
    ];
    const violations = scanRoots(roots);
    expect(
      violations,
      violations
        .map((v) => `${v.file}:${v.line} "${v.term}" -> ${v.snippet}`)
        .join("\n"),
    ).toHaveLength(0);
  });
});
