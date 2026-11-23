import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/config.js";

describe("forklift.yaml schema", () => {
  it("parses a valid minimal manifest with sensible defaults", () => {
    const manifest = parseManifest(`
version: 1
upstream:
  repo: pingdotgg/t3code
`);
    expect(manifest.upstream.ref).toBe("main");
    expect(manifest.upstream.remote).toBe("upstream");
    expect(manifest.upstream.strategy).toBe("squash");
    expect(manifest.sync.branch_prefix).toBe("forklift/sync/");
    expect(manifest.guardrails.touchpoints.mode).toBe("warn");
  });

  it("rejects autofix brand_leaks rule without replace", () => {
    expect(() =>
      parseManifest(`
version: 1
upstream:
  repo: pingdotgg/t3code
guardrails:
  brand_leaks:
    rules:
      - id: bad-rule
        literal: "T3 Code"
        mode: autofix
`),
    ).toThrow(/requires a "replace" value/);
  });

  it("rejects duplicate hook ids", () => {
    expect(() =>
      parseManifest(`
version: 1
upstream:
  repo: pingdotgg/t3code
hooks:
  - id: nav
    paths: [a.ts]
    intent: "First"
  - id: nav
    paths: [b.ts]
    intent: "Second"
`),
    ).toThrow(/Duplicate hook id "nav"/);
  });
});
