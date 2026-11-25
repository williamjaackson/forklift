import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { AGENT_PRESETS, compileRules, githubSlug, matcher, parseConfig, parseDuration, upstreamUrl } from "../src/config.js";
import { runInit } from "../src/init.js";
import { makeFixture, type Fixture } from "./helpers.js";

describe("forklift.yaml", () => {
  it("needs only an upstream", () => {
    const config = parseConfig("upstream: pingdotgg/t3code\n");
    expect(config.upstream).toEqual({ url: "pingdotgg/t3code", branch: "main", remote: "upstream" });
    expect(config.land).toEqual({ clean: "push", resolved: "pr" });
    expect(config.agent).toBeUndefined();
    expect(config.sync_branch).toBe("forklift/sync");
  });

  it("accepts the full form", () => {
    const config = parseConfig(`
upstream: { url: https://example.com/up.git, branch: develop }
drop: apps/marketing/**
ours: [README.md]
regenerate:
  pnpm-lock.yaml: pnpm install --lockfile-only
forbid:
  - { pattern: 't3\\.codes', in: 'apps/**', replace: example.com }
verify:
  - pnpm test
  - { name: types, run: pnpm tc }
agent: { run: claude, timeout: 10m, attempts: 3 }
notes: Keep the name.
`);
    expect(config.upstream.branch).toBe("develop");
    expect(config.drop).toEqual(["apps/marketing/**"]);
    expect(config.forbid[0]).toMatchObject({ pattern: "t3\\.codes", in: ["apps/**"], replace: "example.com" });
    expect(config.verify).toEqual([{ name: "pnpm test", run: "pnpm test" }, { name: "types", run: "pnpm tc" }]);
    expect(config.agent).toEqual({ run: AGENT_PRESETS.claude, timeoutMs: 600_000, attempts: 3 });
  });

  it("explains what is wrong", () => {
    expect(() => parseConfig("drop: [a]\n")).toThrow(/upstream/);
    expect(() => parseConfig("upstream: a/b\nhooks: []\n")).toThrow(/hooks/);
    expect(() => parseConfig("upstream: a/b\nforbid:\n  - pattern: '('\n")).toThrow(/regular expression/);
    expect(() => parseConfig("upstream: a/b\nretry_after: soon\n")).toThrow(/duration/);
  });

  it("decides which rule settles a path: drop, then regenerate, then ours", () => {
    const rules = compileRules(
      parseConfig("upstream: a/b\ndrop: [ci]\nours: ['**/*.md', pnpm-lock.yaml]\nregenerate:\n  pnpm-lock.yaml: pnpm i\n"),
    );
    expect(rules.ruleFor("ci/build.yml")).toBe("drop");
    expect(rules.ruleFor("ci/README.md")).toBe("drop");
    expect(rules.ruleFor("pnpm-lock.yaml")).toBe("regenerate");
    expect(rules.ruleFor("docs/guide.md")).toBe("ours");
    expect(rules.ruleFor("src/index.ts")).toBeNull();
  });

  it("matches dotfiles and treats a bare directory as everything under it", () => {
    const isMatch = matcher([".github/workflows", "*.lock"]);
    expect(isMatch(".github/workflows/ci.yml")).toBe(true);
    expect(isMatch(".github/CODEOWNERS")).toBe(false);
    expect(isMatch("yarn.lock")).toBe(true);
  });

  it("understands durations and upstream shorthands", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(() => parseDuration("12")).toThrow();
    expect(upstreamUrl("pingdotgg/t3code")).toBe("https://github.com/pingdotgg/t3code.git");
    expect(upstreamUrl("/srv/git/up.git")).toBe("/srv/git/up.git");
    expect(githubSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(githubSlug("https://gitlab.com/owner/repo.git")).toBeNull();
  });
});

describe("check and init", () => {
  let fx: Fixture;
  afterEach(async () => {
    await fx?.cleanup();
  });

  it("check: finds forbidden text and dropped paths anywhere in the tree", async () => {
    fx = await makeFixture({ "ui/a.txt": "T3 Code\nfine\n", "ci/build.yml": "v1\n", "docs/b.txt": "T3 Code\n" });
    await fx.configure("drop: [ci/**]\nforbid:\n  - pattern: 'T3 Code'\n    in: ui/**\n    replace: Bonfire\n");

    const before = await runCheck({ cwd: fx.fork });
    expect(before.ok).toBe(false);
    expect(before.hits).toMatchObject([{ file: "ui/a.txt", line: 1 }]);
    expect(before.present).toEqual(["ci/build.yml"]);

    const fixed = await runCheck({ cwd: fx.fork, fix: true });
    expect(fixed.hits).toEqual([]);
    expect(fixed.replaced).toEqual([{ file: "ui/a.txt", lines: 1 }]);
    expect(await fs.readFile(path.join(fx.fork, "ui/a.txt"), "utf8")).toBe("Bonfire\nfine\n");
  });

  it("init: works out the rules a fork already follows", async () => {
    fx = await makeFixture({
      "app.txt": "one\n",
      "pnpm-lock.yaml": "lock\n",
      "ci/build.yml": "v1\n",
      "ci/test.yml": "v1\n",
      "docs/a.md": "a\n",
      "docs/b.md": "b\n",
    });
    await fx.forkCommit({ "ci/build.yml": null, "ci/test.yml": null, "docs/a.md": null }, "fork: trim");
    const { git } = await import("../src/git.js");
    await git(fx.fork, ["fetch", "--quiet", fx.upstream, "+refs/heads/main:refs/remotes/upstream/main"]);

    const result = await runInit({ cwd: fx.fork, upstream: "owner/project" });

    expect(result.drop).toEqual(["ci/**", "docs/a.md"]);
    expect(result.regenerate).toEqual({ "pnpm-lock.yaml": "pnpm install --lockfile-only" });
    const written = parseConfig(await fs.readFile(result.file, "utf8"));
    expect(written.upstream.url).toBe("owner/project");
    expect(written.drop).toEqual(["ci/**", "docs/a.md"]);
    await expect(runInit({ cwd: fx.fork, upstream: "owner/project" })).rejects.toThrow(/already exists/);
  });
});
