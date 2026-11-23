import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiRunner } from "../src/ai.js";
import { loadLock, saveManifest } from "../src/config.js";
import { revParse, runGit } from "../src/git.js";
import { runInit } from "../src/init.js";
import { runSync } from "../src/sync.js";

const tmpDirs: string[] = [];

async function makeGitDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("forklift sync end-to-end", () => {
  it("handles owned, dropped, clean 3-way merge, AI conflict lift, brand-leak autofix, and generated commands", async () => {
    // 1. Create upstream repo at v1
    const upstreamDir = await makeGitDir("forklift-upstream-");
    await fs.mkdir(path.join(upstreamDir, "src"), { recursive: true });
    await fs.mkdir(path.join(upstreamDir, ".github/workflows"), { recursive: true });
    await fs.writeFile(path.join(upstreamDir, "README.md"), "# Upstream T3 Code\n");
    await fs.writeFile(path.join(upstreamDir, ".github/workflows/release.yml"), "name: Release\n");
    await fs.writeFile(path.join(upstreamDir, "src/clean.ts"), "export const v = 1;\n");
    await fs.writeFile(
      path.join(upstreamDir, "src/Sidebar.tsx"),
      "export function Sidebar() {\n  return <nav>Threads</nav>;\n}\n",
    );
    await fs.writeFile(path.join(upstreamDir, "lock.txt"), "lock-v1\n");
    await runGit(upstreamDir, ["add", "-A"]);
    await runGit(upstreamDir, ["commit", "-m", "upstream v1"]);

    // 2. Clone into fork repo and customize it
    const forkDir = await fs.mkdtemp(path.join(os.tmpdir(), "forklift-fork-"));
    tmpDirs.push(forkDir);
    await runGit(forkDir, ["clone", upstreamDir, "."]);
    await runGit(forkDir, ["config", "user.name", "Fork User"]);
    await runGit(forkDir, ["config", "user.email", "fork@example.com"]);
    await runGit(forkDir, ["remote", "rename", "origin", "upstream"]);

    // Fork customizations: own README, drop upstream workflow, hook Sidebar.tsx
    await fs.writeFile(path.join(forkDir, "README.md"), "# Bonfire Fork\n");
    await fs.rm(path.join(forkDir, ".github/workflows/release.yml"));
    await fs.writeFile(
      path.join(forkDir, "src/Sidebar.tsx"),
      "export function Sidebar() {\n  return <nav><BonfireSwitcher />Threads</nav>;\n}\n",
    );
    await runGit(forkDir, ["add", "-A"]);
    await runGit(forkDir, ["commit", "-m", "bonfire customizations"]);

    // Initialize forklift & configure manifest
    const initRes = await runInit({ cwd: forkDir });
    initRes.manifest.paths.owned.push("README.md");
    initRes.manifest.paths.dropped.push(".github/workflows/**");
    initRes.manifest.paths.generated.push({
      paths: ["lock.txt"],
      run: "node -e \"require('fs').writeFileSync('lock.txt', 'regenerated\\n')\"",
    });
    initRes.manifest.hooks = [
      {
        id: "workspace-switcher",
        paths: ["src/Sidebar.tsx"],
        intent: "Render <BonfireSwitcher /> inside the navigation container.",
        review: "auto",
      },
    ];
    initRes.manifest.guardrails.brand_leaks.rules = [
      {
        id: "upstream-name",
        literal: "T3 Code",
        replace: "Bonfire",
        case_sensitive: false,
        include: ["src/**"],
        mode: "autofix",
      },
    ];
    await saveManifest(forkDir, initRes.manifest);
    await runGit(forkDir, ["add", "-A"]);
    await runGit(forkDir, ["commit", "-m", "add forklift manifest"]);

    // 3. Advance upstream to v2 (modify owned, dropped, clean, conflicting hook, new brand leak, lock.txt)
    await fs.writeFile(path.join(upstreamDir, "README.md"), "# Upstream v2\n");
    await fs.writeFile(path.join(upstreamDir, ".github/workflows/release.yml"), "name: Release v2\n");
    await fs.writeFile(path.join(upstreamDir, "src/clean.ts"), "export const v = 2;\n");
    await fs.writeFile(path.join(upstreamDir, "src/Modal.tsx"), 'export const msg = "About T3 Code";\n');
    await fs.writeFile(
      path.join(upstreamDir, "src/Sidebar.tsx"),
      "export function Sidebar() {\n  return <aside><span>Pinned</span>Threads v2</aside>;\n}\n",
    );
    await fs.writeFile(path.join(upstreamDir, "lock.txt"), "lock-v2\n");
    await runGit(upstreamDir, ["add", "-A"]);
    await runGit(upstreamDir, ["commit", "-m", "upstream v2"]);
    const upstreamV2Sha = await revParse(upstreamDir, "HEAD");

    // 4. Run sync with deterministic mock AI runner
    let aiCalls = 0;
    const mockAi: AiRunner = {
      name: "mock-ai",
      async resolveConflict(req) {
        aiCalls++;
        expect(req.filePath).toBe("src/Sidebar.tsx");
        expect(req.hooks[0]?.id).toBe("workspace-switcher");
        return {
          content:
            "export function Sidebar() {\n  return <aside><BonfireSwitcher /><span>Pinned</span>Threads v2</aside>;\n}\n",
          summary: "Lifted workspace-switcher onto refactored <aside>",
          provider: "mock-ai",
        };
      },
      async repairVerification() {
        return { fixed: false, summary: "unused", provider: "mock-ai" };
      },
    };

    const syncRes = await runSync({ cwd: forkDir, aiRunner: mockAi });

    expect(syncRes.upToDate).toBe(false);
    expect(syncRes.targetSha).toBe(upstreamV2Sha);
    expect(aiCalls).toBe(1);
    expect(syncRes.ownedShielded).toContain("README.md");
    expect(syncRes.droppedKept).toContain(".github/workflows/release.yml");
    expect(syncRes.cleanFiles).toContain("src/clean.ts");
    expect(syncRes.liftedFiles).toHaveLength(1);
    expect(syncRes.checkReport.brandLeaksFixed).toBe(1);
    expect(syncRes.readyToMerge).toBe(true);

    // Verify resulting files on disk
    expect(await fs.readFile(path.join(forkDir, "README.md"), "utf8")).toBe("# Bonfire Fork\n");
    await expect(fs.access(path.join(forkDir, ".github/workflows/release.yml"))).rejects.toThrow();
    expect(await fs.readFile(path.join(forkDir, "src/clean.ts"), "utf8")).toBe("export const v = 2;\n");
    expect(await fs.readFile(path.join(forkDir, "src/Sidebar.tsx"), "utf8")).toContain("<BonfireSwitcher />");
    expect(await fs.readFile(path.join(forkDir, "src/Sidebar.tsx"), "utf8")).toContain("Threads v2");
    expect(await fs.readFile(path.join(forkDir, "src/Modal.tsx"), "utf8")).toContain("About Bonfire");
    expect(await fs.readFile(path.join(forkDir, "lock.txt"), "utf8")).toBe("regenerated\n");

    const updatedLock = await loadLock(forkDir);
    expect(updatedLock.upstream.sha).toBe(upstreamV2Sha);
  });
});
