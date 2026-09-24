import { describe, expect, it } from "vitest";
import {
  CONFIG_PACKAGE,
  prettierConfig,
  tsBaseConfig,
  TS_BASE_EXTENDS,
  baseEslintConfig,
  kshemaPlugin,
  PLUGIN_NAME,
} from "./index";

// Smoke test proving Vitest is wired through the Turborepo `test` pipeline.
describe("@kshema/config barrel", () => {
  it("exposes its package identifier", () => {
    expect(CONFIG_PACKAGE).toBe("@kshema/config");
  });

  it("re-exports the shared presets", () => {
    expect(prettierConfig).toBeTypeOf("object");
    expect(tsBaseConfig).toBeTypeOf("object");
    expect(TS_BASE_EXTENDS).toBe("../../tsconfig.base.json");
  });

  it("re-exports the ESLint preset wiring the custom plugin", () => {
    expect(Array.isArray(baseEslintConfig)).toBe(true);
    expect(kshemaPlugin.rules).toHaveProperty("no-banned-terms");
    expect(PLUGIN_NAME).toBe("kshema");
  });
});

describe("prettier preset", () => {
  it("matches the repo's formatting contract", () => {
    expect(prettierConfig.semi).toBe(true);
    expect(prettierConfig.singleQuote).toBe(false);
    expect(prettierConfig.tabWidth).toBe(2);
    expect(prettierConfig.trailingComma).toBe("all");
    expect(prettierConfig.endOfLine).toBe("lf");
  });
});

describe("typescript preset", () => {
  it("stays in sync with the strict base contract", () => {
    expect(tsBaseConfig.strict).toBe(true);
    expect(tsBaseConfig.noUncheckedIndexedAccess).toBe(true);
    expect(tsBaseConfig.target).toBe("ES2022");
    expect(tsBaseConfig.moduleResolution).toBe("Bundler");
  });
});

describe("eslint preset", () => {
  it("registers the kshema plugin and enables no-banned-terms as an error", () => {
    const withPlugin = baseEslintConfig.find((entry) => entry.plugins?.[PLUGIN_NAME]);
    expect(withPlugin).toBeDefined();
    const ruleSetting = withPlugin?.rules?.[`${PLUGIN_NAME}/no-banned-terms`] as [
      string,
      { exceptions: Record<string, readonly string[]> },
    ];
    expect(Array.isArray(ruleSetting)).toBe(true);
    expect(ruleSetting[0]).toBe("error");
    // The bounded philosophy-tenet exception is wired in repo-wide.
    expect(ruleSetting[1].exceptions).toHaveProperty("philosophy.heading");
  });

  it("ignores build artifact directories", () => {
    const ignoreEntry = baseEslintConfig.find((entry) => entry.ignores);
    expect(ignoreEntry?.ignores).toContain("dist/**");
    expect(ignoreEntry?.ignores).toContain("node_modules/**");
  });
});
