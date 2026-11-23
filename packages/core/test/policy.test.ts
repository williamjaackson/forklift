import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/config.js";
import { createPolicyClassifier } from "../src/policy.js";

describe("path policy precedence", () => {
  const manifest = parseManifest(`
version: 1
upstream:
  repo: pingdotgg/t3code
paths:
  owned:
    - assets/**
    - .github/workflows/bonfire-*.yml
  dropped:
    - .github/workflows/**
    - apps/marketing/**
  generated:
    - paths: [pnpm-lock.yaml]
      run: pnpm install --no-frozen-lockfile
      triggers: ["**/package.json"]
hooks:
  - id: sidebar
    paths: [apps/web/src/Sidebar.tsx]
    intent: "Inject Bonfire switcher"
`);

  const classifier = createPolicyClassifier(manifest);

  it("always classifies forklift.yaml and forklift.lock as owned", () => {
    expect(classifier.classify("forklift.yaml").kind).toBe("owned");
    expect(classifier.classify("forklift.lock").kind).toBe("owned");
  });

  it("gives owned precedence over dropped (e.g. bonfire workflow inside dropped workflows dir)", () => {
    expect(classifier.classify(".github/workflows/release.yml").kind).toBe("dropped");
    expect(classifier.classify(".github/workflows/bonfire-ci.yml").kind).toBe("owned");
  });

  it("classifies hooks, generated, and default upstream paths correctly", () => {
    expect(classifier.classify("apps/web/src/Sidebar.tsx").kind).toBe("hook");
    expect(classifier.classify("pnpm-lock.yaml").kind).toBe("generated");
    expect(classifier.classify("apps/web/src/App.tsx").kind).toBe("upstream");
  });

  it("triggers generated rules when trigger globs match", () => {
    const matched = classifier.matchingGeneratedRules(["apps/web/package.json"]);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.run).toBe("pnpm install --no-frozen-lockfile");
  });
});
