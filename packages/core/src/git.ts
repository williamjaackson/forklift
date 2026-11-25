import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, type RunResult } from "./exec.js";

export interface GitOptions {
  allowFailure?: boolean;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Settings every Forklift git call uses: paths are taken literally (never as
 * patterns), and the fork's own git hooks do not run on Forklift's commits.
 */
const BASE_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<RunResult> {
  const result = await run("git", [...BASE_ARGS, ...args], {
    cwd,
    input: options.input,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: { ...(options.env ?? process.env), GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
  });
  if (result.code !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

const MIN_GIT = [2, 38] as const;

/**
 * How many renamed files git will try to match up in one merge. Set the same
 * for the real merge and for the in-memory one, so both reach the same answer.
 */
export const RENAME_LIMIT = 30000;

export async function assertGitVersion(cwd: string): Promise<void> {
  const { stdout } = await git(cwd, ["--version"]);
  const match = /(\d+)\.(\d+)/.exec(stdout);
  if (!match) return;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new Error(`Forklift needs git ${MIN_GIT.join(".")} or newer; found ${major}.${minor}.`);
  }
}

export interface Repo {
  /** Top of the user's checkout (or the bare repo). */
  root: string;
  /** The shared .git directory, where Forklift keeps its own state. */
  commonDir: string;
}

export async function openRepo(cwd: string): Promise<Repo> {
  const inside = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    allowFailure: true,
  });
  if (inside.code !== 0) throw new Error(`${cwd} is not a git repository.`);
  const commonDir = inside.stdout.trim();
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return { root: top.code === 0 ? top.stdout.trim() : commonDir, commonDir };
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return stdout.trim();
}

export async function tryRevParse(cwd: string, ref: string): Promise<string | null> {
  const res = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
  });
  return res.code === 0;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const res = await git(cwd, ["merge-base", a, b], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function countCommits(cwd: string, range: string): Promise<number> {
  const { stdout } = await git(cwd, ["rev-list", "--count", range]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function remoteUrl(cwd: string, remote: string): Promise<string | null> {
  const res = await git(cwd, ["remote", "get-url", remote], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function showFile(cwd: string, ref: string, file: string): Promise<string | null> {
  const res = await git(cwd, ["show", `${ref}:${file}`], { allowFailure: true });
  return res.code === 0 ? res.stdout : null;
}

/** Fetch one branch from a remote name or URL into a tracking ref; returns its commit. */
export async function fetchBranch(
  cwd: string,
  source: string,
  branch: string,
  trackingRef: string,
): Promise<string> {
  await git(cwd, ["fetch", "--quiet", "--no-tags", source, `+refs/heads/${branch}:${trackingRef}`]);
  return revParse(cwd, trackingRef);
}

export function splitNul(text: string): string[] {
  return text.split("\0").filter((part) => part.length > 0);
}

export type ConflictKind =
  | "both-changed"
  | "both-added"
  | "deleted-by-fork"
  | "deleted-by-upstream"
  | "renamed";

export interface Conflict {
  path: string;
  kind: ConflictKind;
  /** Index stages present: 1 = common ancestor, 2 = fork, 3 = upstream. */
  stages: number[];
}

function kindOf(stages: number[]): ConflictKind {
  const key = stages.join("");
  if (key === "123") return "both-changed";
  if (key === "23") return "both-added";
  if (key === "13") return "deleted-by-fork";
  if (key === "12") return "deleted-by-upstream";
  return "renamed";
}

/** Parse `<mode> <oid> <stage>\t<path>` records, as ls-files -u and merge-tree print them. */
function parseStageRecords(records: string[]): Conflict[] {
  const stagesByPath = new Map<string, number[]>();
  for (const record of records) {
    const match = /^\d+ [0-9a-f]+ ([123])\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const list = stagesByPath.get(match[2]!) ?? [];
    list.push(Number(match[1]));
    stagesByPath.set(match[2]!, list);
  }
  return [...stagesByPath.entries()]
    .map(([file, stages]) => {
      const sorted = [...new Set(stages)].sort();
      return { path: file, stages: sorted, kind: kindOf(sorted) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Paths still in conflict in a checkout with a merge in progress. */
export async function unmergedPaths(cwd: string, options: GitOptions = {}): Promise<Conflict[]> {
  const { stdout } = await git(cwd, ["ls-files", "-u", "-z"], options);
  return parseStageRecords(splitNul(stdout));
}

/**
 * Merge two commits in memory, touching neither a checkout nor the index,
 * and report which paths would conflict.
 */
export async function predictMerge(cwd: string, ours: string, theirs: string): Promise<Conflict[]> {
  return (await mergeInMemory(cwd, ours, theirs)).conflicts;
}

/**
 * What `git merge` produces by itself for two commits: the merged tree (with
 * conflict markers written into any file it could not merge) and the paths
 * that conflicted. Nothing is checked out and no code from either side runs.
 */
export async function mergeInMemory(
  cwd: string,
  ours: string,
  theirs: string,
): Promise<{ tree: string; conflicts: Conflict[] }> {
  const res = await git(
    cwd,
    ["-c", `merge.renameLimit=${RENAME_LIMIT}`, "merge-tree", "--write-tree", "--no-messages", "-z", ours, theirs],
    { allowFailure: true },
  );
  if (res.code !== 0 && res.code !== 1) {
    throw new Error(`git merge-tree failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  // First record is the merged tree; the rest are conflicted-file records.
  const [tree = "", ...records] = res.stdout.split("\0");
  return { tree: tree.trim(), conflicts: res.code === 0 ? [] : parseStageRecords(records) };
}

/** Run a git command over many paths without hitting argument-length limits. */
export async function gitWithPaths(
  cwd: string,
  args: string[],
  paths: string[],
  options: GitOptions = {},
): Promise<void> {
  if (paths.length === 0) return;
  await git(cwd, [...args, "--pathspec-from-file=-", "--pathspec-file-nul"], {
    ...options,
    input: paths.join("\0"),
  });
}

/**
 * Read many files straight from git's object store, with one git process.
 * Keys of the result are the specs asked for (`<commit or tree>:<path>`); a
 * spec that does not name a file maps to null.
 */
export async function readBlobs(
  cwd: string,
  specs: string[],
  options: GitOptions = {},
): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>();
  const CHUNK = 400;
  for (let start = 0; start < specs.length; start += CHUNK) {
    const chunk = specs.slice(start, start + CHUNK);
    const res = await git(cwd, ["cat-file", "--batch"], {
      ...options,
      input: chunk.join("\n") + "\n",
      maxBuffer: 1024 * 1024 * 1024,
    });
    const bytes = res.stdoutBytes;
    let offset = 0;
    for (const spec of chunk) {
      const lineEnd = bytes.indexOf(0x0a, offset);
      if (lineEnd < 0) throw new Error("git cat-file --batch ended early");
      const header = bytes.subarray(offset, lineEnd).toString("utf8");
      offset = lineEnd + 1;
      const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!match) {
        // "<spec> missing", or an ambiguous name.
        found.set(spec, null);
        continue;
      }
      const size = Number(match[2]);
      found.set(spec, match[1] === "blob" ? bytes.subarray(offset, offset + size) : null);
      offset += size + 1;
    }
  }
  return found;
}

/** Where Forklift builds merges for this repository: outside the user's checkout. */
export function workspaceDir(repo: Repo): string {
  const home =
    process.env.FORKLIFT_HOME ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "forklift");
  const id = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 10);
  const name = path.basename(repo.root).replace(/\.git$/, "") || "repo";
  return path.join(home, "worktrees", `${name}-${id}`);
}

/**
 * Check out `commit` in Forklift's workspace for this repository.
 *
 * The workspace is a repository of its own. It reads the main repository's
 * objects (so nothing is copied) but has its own configuration, index and
 * refs: the agent and the fork's commands run here, and whatever they do to
 * git's settings here does not follow Forklift back to the repository where
 * it fetches and pushes. `env` carries no credentials, and every git command
 * in the workspace uses it.
 *
 * It is reused between runs, so installed dependencies, build caches and
 * recorded conflict resolutions survive; tracked files and untracked
 * leftovers are reset every time.
 */
export async function prepareWorkspace(
  repo: Repo,
  dir: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const objects = path.join(repo.commonDir, "objects");
  const alternates = path.join(dir, ".git", "objects", "info", "alternates");
  const current = await fs.readFile(alternates, "utf8").catch(() => null);

  if (current?.trim() === objects) {
    await git(dir, ["merge", "--abort"], { allowFailure: true, env });
    await git(dir, ["reset", "--quiet", "--hard"], { allowFailure: true, env });
  } else {
    // Nothing here, or something left by an older Forklift: start clean.
    await fs.rm(dir, { recursive: true, force: true });
    await git(repo.commonDir, ["worktree", "prune"], { allowFailure: true });
    await fs.mkdir(dir, { recursive: true });
    await git(dir, ["init", "--quiet"], { env });
    await fs.mkdir(path.dirname(alternates), { recursive: true });
    await fs.writeFile(alternates, `${objects}\n`);
  }
  await git(dir, ["checkout", "--quiet", "--force", "--detach", commit], { env });
  await git(dir, ["clean", "--quiet", "-fd"], { env });
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export async function commitInfo(cwd: string, ref: string): Promise<CommitInfo> {
  const { stdout } = await git(cwd, ["log", "-1", "--format=%H%x00%s%x00%an%x00%cI", ref]);
  const [sha = "", subject = "", author = "", date = ""] = stdout.trimEnd().split("\0");
  return { sha, subject, author, date };
}

/** One-line log entries (`<short sha> <subject>`), newest first. */
export async function logLines(
  cwd: string,
  range: string,
  options: { file?: string; limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const args = ["log", "--format=%h %s"];
  if (options.limit) args.push(`--max-count=${options.limit}`);
  args.push(range);
  if (options.file) args.push("--", options.file);
  const res = await git(cwd, args, { allowFailure: true, env: options.env });
  return res.code === 0 ? res.stdout.split("\n").filter(Boolean) : [];
}

export interface Identity {
  name: string;
  email: string;
}

/**
 * Who Forklift's merge commits are from. Never the person whose machine or
 * token it happens to be running with: a sync is the bot's work, not theirs.
 * The address is one no GitHub account can claim, so a commit is not
 * credited to a stranger. With a GitHub App configured, the App's own bot
 * identity is used instead (see auth.ts).
 */
export function defaultIdentity(): Identity {
  return {
    name: process.env.FORKLIFT_GIT_NAME ?? "forklift[bot]",
    email: process.env.FORKLIFT_GIT_EMAIL ?? "bot@forklift.invalid",
  };
}

export function identityEnv(identity: Identity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
