import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  cwd: string,
  args: string[],
  options?: { allowFailure?: boolean },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    if (options?.allowFailure) {
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
        exitCode,
      };
    }
    throw new Error(
      `git ${args.join(" ")} failed (exit ${exitCode}): ${(e.stderr || e.message || "").trim()}`,
    );
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ["status", "--porcelain"]);
  return res.stdout.trim().length === 0;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const res = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const res = await runGit(cwd, ["rev-parse", ref]);
  return res.stdout.trim();
}

export async function tryRevParse(cwd: string, ref: string): Promise<string | null> {
  const res = await runGit(cwd, ["rev-parse", "--verify", ref], {
    allowFailure: true,
  });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

export async function getRemoteUrl(cwd: string, remote: string): Promise<string | null> {
  const res = await runGit(cwd, ["remote", "get-url", remote], {
    allowFailure: true,
  });
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

export function repoSlugToUrl(repo: string): string {
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(repo)) {
    return repo;
  }
  return `https://github.com/${repo}.git`;
}

export function urlToRepoSlug(url: string): string {
  const ghHttps = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ghHttps?.[1]) return ghHttps[1];
  return url;
}

export async function ensureUpstreamRemote(
  cwd: string,
  remote: string,
  repo: string,
): Promise<void> {
  const existing = await getRemoteUrl(cwd, remote);
  if (!existing) {
    await runGit(cwd, ["remote", "add", remote, repoSlugToUrl(repo)]);
    await runGit(cwd, ["remote", "set-url", "--push", remote, "DISABLED"]);
  }
}

export async function fetchUpstream(
  cwd: string,
  remote: string,
  ref: string,
): Promise<string> {
  await runGit(cwd, ["fetch", remote, ref]);
  const targetRef = `${remote}/${ref}`;
  const sha = await tryRevParse(cwd, targetRef);
  if (sha) return sha;
  return revParse(cwd, "FETCH_HEAD");
}

export type DiffStatus = "A" | "M" | "D" | "T";

export interface DiffEntry {
  status: DiffStatus;
  path: string;
}

export async function diffNameStatus(
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<DiffEntry[]> {
  const res = await runGit(cwd, [
    "diff",
    "--no-renames",
    "--name-status",
    "-z",
    fromRef,
    toRef,
  ]);
  const parts = res.stdout.split("\0").filter((p) => p.length > 0);
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const rawStatus = parts[i]!.charAt(0) as DiffStatus;
    const filePath = parts[i + 1]!;
    entries.push({ status: rawStatus, path: filePath });
  }
  return entries;
}

export async function listTrackedFiles(cwd: string): Promise<string[]> {
  const res = await runGit(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

export async function readBlob(
  cwd: string,
  ref: string,
  filePath: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${filePath}`], {
      cwd,
      encoding: "buffer",
      maxBuffer: 50 * 1024 * 1024,
    });
    return Buffer.from(stdout);
  } catch {
    return null;
  }
}

export async function countCommits(
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<number> {
  const res = await runGit(cwd, ["rev-list", "--count", `${fromRef}..${toRef}`], {
    allowFailure: true,
  });
  return res.exitCode === 0 ? Number.parseInt(res.stdout.trim(), 10) || 0 : 0;
}

export async function logOneline(
  cwd: string,
  fromRef: string,
  toRef: string,
  options?: { filePath?: string; limit?: number },
): Promise<string[]> {
  const args = ["log", "--oneline"];
  if (options?.limit) args.push(`-n`, String(options.limit));
  args.push(`${fromRef}..${toRef}`);
  if (options?.filePath) args.push("--", options.filePath);
  const res = await runGit(cwd, args, { allowFailure: true });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface ThreeWayMergeResult {
  merged: Buffer;
  clean: boolean;
  conflictCount: number;
}

/**
 * Performs a deterministic 3-way file merge using `git merge-file -p`.
 * Does not touch the git index or working tree.
 */
export async function mergeFileThreeWay(
  ours: Buffer,
  base: Buffer,
  theirs: Buffer,
  labels?: { ours?: string; base?: string; theirs?: string },
): Promise<ThreeWayMergeResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forklift-merge-"));
  const oursPath = path.join(tmpDir, "ours");
  const basePath = path.join(tmpDir, "base");
  const theirsPath = path.join(tmpDir, "theirs");
  try {
    await Promise.all([
      fs.writeFile(oursPath, ours),
      fs.writeFile(basePath, base),
      fs.writeFile(theirsPath, theirs),
    ]);

    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "merge-file",
          "-p",
          "-L",
          labels?.ours ?? "fork (ours)",
          "-L",
          labels?.base ?? "upstream base",
          "-L",
          labels?.theirs ?? "upstream target",
          oursPath,
          basePath,
          theirsPath,
        ],
        { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 },
      );
      return { merged: Buffer.from(stdout), clean: true, conflictCount: 0 };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; code?: number };
      const code = typeof e.code === "number" ? e.code : 1;
      if (code > 0 && code < 128 && e.stdout !== undefined) {
        const merged = Buffer.isBuffer(e.stdout)
          ? e.stdout
          : Buffer.from(e.stdout, "utf8");
        return { merged, clean: false, conflictCount: code };
      }
      throw err;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
