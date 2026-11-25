import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, githubSlug } from "./config.js";
import { run } from "./exec.js";
import { git, mergeBase, openRepo, remoteUrl, splitNul, tryRevParse } from "./git.js";

export interface InitOptions {
  cwd: string;
  /** Upstream as "owner/repo" or a git URL. Default: the `upstream` remote. */
  upstream?: string;
  upstreamBranch?: string;
  force?: boolean;
}

export interface InitResult {
  file: string;
  upstream: string;
  drop: string[];
  regenerate: Record<string, string>;
  agent: string | null;
}

const LOCKFILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install --lockfile-only",
  "package-lock.json": "npm install --package-lock-only",
  "yarn.lock": "yarn install --mode update-lockfile",
  "bun.lock": "bun install --lockfile-only",
  "Cargo.lock": "cargo update --workspace",
  "go.sum": "go mod tidy",
  "poetry.lock": "poetry lock",
  "uv.lock": "uv lock",
  "Gemfile.lock": "bundle lock",
};

/**
 * Paths the fork has deleted since it split from upstream, folded into whole
 * directories where the fork removed all of one.
 */
async function deletedSinceFork(cwd: string, base: string): Promise<string[]> {
  const deleted = splitNul(
    (await git(cwd, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", base, "HEAD"])).stdout,
  );
  if (deleted.length === 0) return [];
  const liveDirs = new Set<string>([""]);
  for (const file of splitNul((await git(cwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])).stdout)) {
    let dir = path.posix.dirname(file);
    while (dir !== "." && !liveDirs.has(dir)) {
      liveDirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const globs = new Set<string>();
  for (const file of deleted) {
    // Climb to the highest directory that no longer exists in the fork.
    let gone: string | null = null;
    let dir = path.posix.dirname(file);
    while (dir !== "." && !liveDirs.has(dir)) {
      gone = dir;
      dir = path.posix.dirname(dir);
    }
    globs.add(gone ? `${gone}/**` : file);
  }
  return [...globs].sort();
}

async function onPath(program: string): Promise<boolean> {
  try {
    return (await run("sh", ["-c", `command -v ${program}`], { cwd: process.cwd() })).code === 0;
  } catch {
    return false;
  }
}

function yamlList(items: string[], indent = "  "): string {
  return items.map((item) => `${indent}- ${JSON.stringify(item)}`).join("\n");
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const repo = await openRepo(options.cwd);
  const file = path.join(repo.root, CONFIG_FILENAME);
  if (!options.force) {
    const exists = await fs.stat(file).then(() => true, () => false);
    if (exists) throw new Error(`${CONFIG_FILENAME} already exists. Use --force to replace it.`);
  }

  const url = options.upstream ?? (await remoteUrl(repo.root, "upstream"));
  if (!url) {
    throw new Error("Which project is this a fork of? Pass --upstream owner/repo (or add a git remote named `upstream`).");
  }
  const upstream = githubSlug(url) ?? url;
  const branch = options.upstreamBranch ?? "main";

  let drop: string[] = [];
  const upstreamTip = await tryRevParse(repo.root, `refs/remotes/upstream/${branch}`);
  if (upstreamTip) {
    const base = await mergeBase(repo.root, "HEAD", upstreamTip);
    if (base) drop = await deletedSinceFork(repo.root, base);
  }

  const regenerate: Record<string, string> = {};
  for (const [lockfile, command] of Object.entries(LOCKFILES)) {
    const tracked = await git(repo.root, ["ls-files", "--error-unmatch", lockfile], { allowFailure: true });
    if (tracked.code === 0) regenerate[lockfile] = command;
  }

  const agent = (await onPath("claude")) ? "claude" : (await onPath("codex")) ? "codex" : null;

  const content = [
    "# Forklift keeps this fork up to date with upstream.",
    "# https://github.com/williamjaackson/forklift",
    "",
    branch === "main" ? `upstream: ${upstream}` : `upstream:\n  url: ${upstream}\n  branch: ${branch}`,
    "",
    "# Paths that must not exist in this fork. Upstream's changes to them are",
    "# ignored, and files upstream adds under them are removed.",
    drop.length > 0 ? `drop:\n${yamlList(drop)}` : "# drop:\n#   - .github/workflows/**",
    "",
    "# Files this fork owns. Upstream's changes to them are never taken.",
    "# ours:\n#   - README.md",
    "",
    "# Files that are rebuilt rather than merged, and the command that rebuilds them.",
    Object.keys(regenerate).length > 0
      ? `regenerate:\n${Object.entries(regenerate).map(([p, c]) => `  ${p}: ${c}`).join("\n")}`
      : "# regenerate:\n#   pnpm-lock.yaml: pnpm install --lockfile-only",
    "",
    "# Text upstream must not bring into this fork. Add `replace` to have",
    "# Forklift rewrite it; without one, the agent is asked to fix it.",
    "# forbid:\n#   - pattern: 'Upstream Product Name'\n#     in: apps/**\n#     replace: 'My Product Name'",
    "",
    "# Commands that must pass before a merge lands. They run in Forklift's own",
    "# checkout, so start with whatever installs dependencies.",
    "# verify:\n#   - npm ci\n#   - npm test",
    "",
    "# The coding agent that resolves conflicts the rules above cannot.",
    "# `claude` and `codex` are built in; any command that reads its task on",
    "# stdin and edits files in the current directory works.",
    agent ? `agent: ${agent}` : "# agent: claude",
    "",
    "# What the agent should know about this fork: what it is, what it changes",
    "# on purpose, and what must survive every merge.",
    "# notes: |\n#   This fork renames the product and removes the hosted features.",
    "",
  ].join("\n");

  await fs.writeFile(file, content, "utf8");
  return { file, upstream, drop, regenerate, agent };
}
