import fs from "node:fs/promises";
import path from "node:path";
import { runBuild, type BuildReport } from "./build.js";
import { loadContext, type Context, type ContextOptions } from "./context.js";
import { readHandoff } from "./handoff.js";
import { publish, tidyProposal, type SyncResult } from "./publish.js";

export type { SyncResult } from "./publish.js";

export interface SyncOptions extends ContextOptions {
  /** Build the merge locally and stop: push nothing, open nothing. */
  dryRun?: boolean;
  /** Always open a pull request, even for a merge that could land directly. */
  pullRequest?: boolean;
  /** Do not run the agent, even if one is configured. */
  noAgent?: boolean;
  /** Try again now, ignoring the back-off and any open proposal. */
  retry?: boolean;
  log?: (line: string) => void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One Forklift at a time per repository. */
export async function withLock<T>(context: Context, work: () => Promise<T>): Promise<T> {
  const stateDir = path.join(context.repo.commonDir, "forklift");
  await fs.mkdir(stateDir, { recursive: true });
  const lock = path.join(stateDir, "lock");
  let held = false;
  for (let attempt = 0; attempt < 2 && !held; attempt++) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: "wx" });
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(await fs.readFile(lock, "utf8").catch(() => "0"));
      if (holder && holder !== process.pid && processAlive(holder)) {
        throw new Error(`Another forklift is working on this repository (pid ${holder}).`);
      }
      await fs.rm(lock, { force: true });
    }
  }
  if (!held) throw new Error("Could not take the lock for this repository.");
  try {
    return await work();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Build and publish in one go.
 *
 * Convenient, and what you want on your own machine. Note what it means: the
 * agent and the fork's commands run as the same user that holds the
 * credentials for pushing. Where that matters (a server, CI, a fork of
 * something you do not fully trust), run `forklift build` and
 * `forklift publish` separately, in different containers or jobs.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const context = await loadContext(options);
  return withLock(context, async () => {
    if (!options.dryRun) await tidyProposal(context);
    // Even in one process the build reaches the publishing half the same way
    // it would from another machine: as a file of data, read back and checked.
    const out = path.join(context.repo.commonDir, "forklift", "handoff.bundle");
    await runBuild(context, {
      out,
      noAgent: options.noAgent,
      fresh: options.retry || options.dryRun,
      log: options.log,
    });
    return publish(context, await readHandoff(context.repo.root, out), {
      dryRun: options.dryRun,
      pullRequest: options.pullRequest,
      log: options.log,
    });
  });
}

/** The build half only: write the build to `out` for `forklift publish`, push nothing. */
export async function runBuildOnly(
  options: ContextOptions & { out: string; noAgent?: boolean; retry?: boolean; log?: (line: string) => void },
): Promise<BuildReport> {
  const context = await loadContext(options);
  return withLock(context, () =>
    runBuild(context, { out: options.out, noAgent: options.noAgent, fresh: options.retry, log: options.log }),
  );
}

/** The publish half only: read a build from `file` and decide what becomes of it. */
export async function runPublishOnly(
  options: ContextOptions & { file: string; dryRun?: boolean; pullRequest?: boolean; log?: (line: string) => void },
): Promise<SyncResult> {
  const context = await loadContext(options);
  return withLock(context, async () => {
    if (!options.dryRun) await tidyProposal(context);
    return publish(context, await readHandoff(context.repo.root, options.file), {
      dryRun: options.dryRun,
      pullRequest: options.pullRequest,
      log: options.log,
    });
  });
}
