import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { credentialArgs, credentialEnv, resolveCredentials } from "./auth.js";
import { githubSlug, upstreamUrl } from "./config.js";
import { git } from "./git.js";
import { runBuildOnly, runPublishOnly, runSync, type SyncOptions } from "./sync.js";

/**
 * `all`: build and publish in this one process.
 * `build`: build only, and leave each result in the hand-off directory. Needs
 *   the agent's credentials and at most read access to the fork.
 * `publish`: publish what a builder left there. Needs the credentials that can
 *   push, and runs no code from the fork or from upstream.
 */
export type Role = "all" | "build" | "publish";

export interface WatchOptions {
  /** Forks to keep in sync: "owner/repo", a git URL, or a path to a clone. */
  repos: string[];
  /** Time between passes, in milliseconds. */
  everyMs: number;
  /** Run one pass and return. */
  once?: boolean;
  role?: Role;
  /** Directory shared by a builder and a publisher. Required for those roles. */
  handoff?: string;
  /** Where clones are kept. Default: $FORKLIFT_HOME or ~/.cache/forklift. */
  home?: string;
  sync?: Pick<SyncOptions, "dryRun" | "pullRequest" | "noAgent">;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export function forkliftHome(): string {
  return (
    process.env.FORKLIFT_HOME ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "forklift")
  );
}

/** A name for `spec` that is safe as a file or directory name. */
function nameOf(spec: string): string {
  const url = upstreamUrl(spec);
  return (githubSlug(url) ?? url.replace(/^\w+:\/\//, "")).replace(/[^\w.-]+/g, "__");
}

/** A local clone for `spec`, made on first use. */
export async function ensureClone(spec: string, home: string, log: (line: string) => void): Promise<string> {
  const asPath = path.resolve(spec);
  const isLocal = await fs.stat(asPath).then((s) => s.isDirectory(), () => false);
  if (isLocal) return asPath;

  const url = upstreamUrl(spec);
  const dir = path.join(home, "repos", `${nameOf(spec)}.git`);
  const exists = await fs.stat(path.join(dir, "HEAD")).then(() => true, () => false);
  if (!exists) {
    log(`cloning ${spec}`);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rm(dir, { recursive: true, force: true });
    const credentials = await resolveCredentials(githubSlug(url));
    // Bare: Forklift works in its own workspace and never needs a second checkout.
    await git(path.dirname(dir), [...credentialArgs(credentials, url), "clone", "--quiet", "--bare", url, dir], {
      env: credentialEnv(credentials),
    });
  }
  return dir;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface PassResult {
  repo: string;
  /** What happened, in one line. */
  summary?: string;
  error?: string;
}

/** Go through every repository once. One failing repository does not stop the others. */
export async function runPass(options: WatchOptions): Promise<PassResult[]> {
  const log = options.log ?? (() => {});
  const home = options.home ?? forkliftHome();
  const role = options.role ?? "all";
  if (role !== "all" && !options.handoff) {
    throw new Error(`The ${role} role needs a hand-off directory (--handoff or FORKLIFT_HANDOFF).`);
  }
  const results: PassResult[] = [];
  for (const repo of options.repos) {
    if (options.signal?.aborted) break;
    const tag = (line: string) => log(`[${repo}] ${line}`);
    try {
      const cwd = await ensureClone(repo, home, tag);
      const file = options.handoff ? path.join(options.handoff, `${nameOf(repo)}.bundle`) : "";
      let summary: string;
      if (role === "build") {
        const report = await runBuildOnly({ cwd, out: file, noAgent: options.sync?.noAgent, log: tag });
        summary = report.skipped
          ? `${report.skipped.outcome}: ${report.skipped.summary}`
          : report.merge
            ? `built a merge of ${report.merge.commits} upstream commit${report.merge.commits === 1 ? "" : "s"}${report.openConflicts ? ", then blocked on a conflict" : ""}`
            : "blocked on a conflict; nothing could be merged";
      } else if (role === "publish") {
        const ready = await fs.stat(file).then(() => true, () => false);
        if (!ready) {
          summary = "no build to publish yet";
        } else {
          const result = await runPublishOnly({ cwd, file, ...options.sync, log: tag });
          summary = `${result.outcome}: ${result.summary}`;
        }
      } else {
        const result = await runSync({ cwd, ...options.sync, log: tag });
        summary = `${result.outcome}: ${result.summary}`;
      }
      tag(summary);
      results.push({ repo, summary });
    } catch (err) {
      const error = (err as Error).message;
      tag(`failed: ${error}`);
      results.push({ repo, error });
    }
  }
  return results;
}

/** Keep going until stopped. */
export async function runWatch(options: WatchOptions): Promise<void> {
  const log = options.log ?? (() => {});
  if (options.repos.length === 0) {
    throw new Error("No repositories to watch. Pass them as arguments or set FORKLIFT_REPOS.");
  }
  for (;;) {
    await runPass(options);
    if (options.once || options.signal?.aborted) return;
    log(`next pass in ${Math.round(options.everyMs / 60_000)} min`);
    await sleep(options.everyMs, options.signal);
    if (options.signal?.aborted) return;
  }
}
