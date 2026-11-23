import fs from "node:fs/promises";
import path from "node:path";
import {
  LOCK_FILENAME,
  MANIFEST_FILENAME,
  lockPath,
  manifestPath,
  saveLock,
  saveManifest,
} from "./config.js";
import {
  diffNameStatus,
  ensureUpstreamRemote,
  getRemoteUrl,
  isGitRepo,
  revParse,
  runGit,
  tryRevParse,
  urlToRepoSlug,
} from "./git.js";
import { ForkliftManifestSchema, type ForkliftLock, type ForkliftManifest } from "./schema.js";

export interface InitOptions {
  cwd: string;
  upstream?: string;
  ref?: string;
  remote?: string;
  strategy?: "squash" | "merge";
  force?: boolean;
}

export interface InitResult {
  manifest: ForkliftManifest;
  lock: ForkliftLock;
  detectedOwned: string[];
  detectedDropped: string[];
  detectedHooks: string[];
  detectedGenerated: string[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const {
    cwd,
    ref = "main",
    remote = "upstream",
    strategy = "squash",
    force = false,
  } = options;

  if (!(await isGitRepo(cwd))) {
    throw new Error(`${cwd} is not a git repository.`);
  }

  if (!force && (await fileExists(manifestPath(cwd)))) {
    throw new Error(
      `${MANIFEST_FILENAME} already exists. Pass --force to overwrite.`,
    );
  }

  let upstreamRepo = options.upstream;
  if (!upstreamRepo) {
    const remoteUrl = await getRemoteUrl(cwd, remote);
    if (!remoteUrl) {
      throw new Error(
        `Could not detect "${remote}" git remote. Pass --upstream <owner/repo>.`,
      );
    }
    upstreamRepo = urlToRepoSlug(remoteUrl);
  } else {
    await ensureUpstreamRemote(cwd, remote, upstreamRepo);
  }

  // Determine base upstream SHA
  const upstreamRef = `${remote}/${ref}`;
  let baseSha: string | null = null;
  if (await tryRevParse(cwd, upstreamRef)) {
    const mb = await runGit(cwd, ["merge-base", "HEAD", upstreamRef], {
      allowFailure: true,
    });
    baseSha =
      mb.exitCode === 0 && mb.stdout.trim()
        ? mb.stdout.trim()
        : await revParse(cwd, upstreamRef);
  } else {
    baseSha = await revParse(cwd, "HEAD");
  }

  // Inspect existing fork divergence from baseSha
  const detectedOwned: string[] = [MANIFEST_FILENAME, LOCK_FILENAME];
  const detectedDropped: string[] = [];
  const detectedHooks: string[] = [];
  const detectedGenerated: Array<{ paths: string[]; run: string; triggers?: string[] }> = [];

  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) {
    detectedGenerated.push({
      paths: ["pnpm-lock.yaml"],
      run: "pnpm install --no-frozen-lockfile",
      triggers: ["**/package.json", "pnpm-workspace.yaml"],
    });
  } else if (await fileExists(path.join(cwd, "package-lock.json"))) {
    detectedGenerated.push({
      paths: ["package-lock.json"],
      run: "npm install --package-lock-only",
      triggers: ["**/package.json"],
    });
  } else if (await fileExists(path.join(cwd, "yarn.lock"))) {
    detectedGenerated.push({
      paths: ["yarn.lock"],
      run: "yarn install",
      triggers: ["**/package.json"],
    });
  }

  const headSha = await revParse(cwd, "HEAD");
  if (baseSha !== headSha) {
    const diffs = await diffNameStatus(cwd, baseSha, "HEAD");
    for (const entry of diffs) {
      if (entry.path === MANIFEST_FILENAME || entry.path === LOCK_FILENAME) continue;
      if (detectedGenerated.some((g) => g.paths.includes(entry.path))) continue;
      if (entry.status === "A") {
        detectedOwned.push(entry.path);
      } else if (entry.status === "D") {
        detectedDropped.push(entry.path);
      } else if (entry.status === "M") {
        detectedHooks.push(entry.path);
      }
    }
  }

  // Detect default verify scripts from package.json if present
  const verify: Array<{ name: string; run: string; agent_fix: boolean }> = [];
  const pkgPath = path.join(cwd, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const pm = (await fileExists(path.join(cwd, "pnpm-lock.yaml")))
        ? "pnpm"
        : "npm run";
      if (pkg.scripts?.typecheck) {
        verify.push({ name: "typecheck", run: `${pm} typecheck`, agent_fix: true });
      }
      if (pkg.scripts?.lint) {
        verify.push({ name: "lint", run: `${pm} lint`, agent_fix: true });
      }
      if (pkg.scripts?.test) {
        verify.push({ name: "test", run: `${pm} test`, agent_fix: false });
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  const hooks = detectedHooks.slice(0, 20).map((filePath, idx) => ({
    id: `hook-${idx + 1}-${path
      .basename(filePath, path.extname(filePath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "file"}`,
    paths: [filePath],
    intent: `Preserve fork customizations in ${filePath} while accepting upstream updates.`,
    review: "auto" as const,
  }));

  const manifest = ForkliftManifestSchema.parse({
    version: 1,
    upstream: {
      repo: upstreamRepo,
      ref,
      remote,
      strategy,
    },
    sync: {
      schedule: "daily",
      branch_prefix: "forklift/sync/",
      pr: {
        title: "[Forklift] Sync upstream → {{target}}",
        labels: ["forklift", "upstream-sync"],
        draft_on_issue: true,
      },
    },
    paths: {
      owned: detectedOwned,
      dropped: detectedDropped,
      generated: detectedGenerated,
    },
    hooks,
    guardrails: {
      touchpoints: { mode: "warn" },
      brand_leaks: {
        exclude: [
          MANIFEST_FILENAME,
          LOCK_FILENAME,
          "**/*.lock",
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
        ],
        rules: [],
      },
    },
    verify,
  });

  const lock: ForkliftLock = {
    version: 1,
    upstream: {
      repo: upstreamRepo,
      ref,
      sha: baseSha,
      synced_at: new Date().toISOString(),
    },
  };

  await saveManifest(cwd, manifest);
  await saveLock(cwd, lock);

  return {
    manifest,
    lock,
    detectedOwned,
    detectedDropped,
    detectedHooks,
    detectedGenerated: detectedGenerated.flatMap((g) => g.paths),
  };
}
