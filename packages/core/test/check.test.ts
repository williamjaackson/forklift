import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { parseManifest } from "../src/config.js";
import { runGit } from "../src/git.js";

const tmpDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forklift-check-"));
  tmpDirs.push(dir);
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("forklift check guardrails", () => {
  it("detects and autofixes brand leaks while flagging error rules and dropped paths", async () => {
    const dir = await makeTempRepo();
    await fs.mkdir(path.join(dir, "apps/web"), { recursive: true });
    await fs.mkdir(path.join(dir, ".github/workflows"), { recursive: true });

    await fs.writeFile(
      path.join(dir, "apps/web/App.tsx"),
      'export const title = "Welcome to T3 Code";\nexport const url = "https://t3.codes";\n',
    );
    await fs.writeFile(
      path.join(dir, ".github/workflows/release.yml"),
      "name: Upstream Release\n",
    );
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-m", "initial"]);

    const manifest = parseManifest(`
version: 1
upstream:
  repo: pingdotgg/t3code
paths:
  dropped:
    - .github/workflows/**
guardrails:
  touchpoints:
    mode: off
  brand_leaks:
    rules:
      - id: product-name
        literal: "T3 Code"
        replace: "Bonfire"
        include: ["apps/**"]
        mode: autofix
      - id: upstream-domain
        match: "t3\\\\.codes"
        include: ["apps/**"]
        mode: error
`);

    const first = await runCheck({ cwd: dir, manifest, lock: null, fix: false });
    expect(first.ok).toBe(false);
    expect(first.droppedPresent).toEqual([".github/workflows/release.yml"]);
    expect(first.brandLeaks).toHaveLength(2);

    const fixed = await runCheck({ cwd: dir, manifest, lock: null, fix: true });
    expect(fixed.brandLeaksFixed).toBe(1);
    expect(fixed.droppedPresent).toHaveLength(0);
    // Error-mode domain leak still fails check so human must review it
    expect(fixed.ok).toBe(false);

    const updatedApp = await fs.readFile(path.join(dir, "apps/web/App.tsx"), "utf8");
    expect(updatedApp).toContain("Welcome to Bonfire");
    expect(updatedApp).toContain("https://t3.codes");
  });
});
