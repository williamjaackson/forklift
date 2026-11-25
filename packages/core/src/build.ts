import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentRun } from "./agent.js";
import { parseDuration } from "./config.js";
import { trailers, type Context } from "./context.js";
import { buildEnv } from "./exec.js";
import { countCommits, defaultIdentity, git, identityEnv, isAncestor, workspaceDir, type Conflict } from "./git.js";
import { writeHandoff } from "./handoff.js";
import { buildMerge, type Build, type MergedBuild } from "./merge.js";
import { findBlocker, predict } from "./plan.js";

export interface BuildOptions {
  /** Where to write the build: one file, read back with `readHandoff`. */
  out: string;
  /** Do not run the agent, even if one is configured. */
  noAgent?: boolean;
  /** Build now: ignore an open proposal and the back-off after a failure. */
  fresh?: boolean;
  log?: (line: string) => void;
}

/**
 * What a build hands to whoever publishes it. Apart from the merged tree,
 * which is checked again, this is the builder's own account of events.
 */
export interface BuildReport {
  version: 1;
  /** The fork and upstream commits the build started from. */
  fork: string;
  target: string;
  base: string;
  behind: number;
  /** Set when there was nothing to build, with the reason. */
  skipped?: { outcome: "up-to-date" | "pending" | "waiting"; summary: string };
  /** The merge that was built: all of upstream, or as much as merges without help. */
  merge?: { target: string; commits: number; build: MergedBuild };
  /** Conflicts nobody settled, when the whole range could not be merged. */
  openConflicts?: Conflict[];
  /** Agent runs that did not end in a merge. */
  agentRuns: AgentRun[];
}

const ConflictSchema = z.object({
  path: z.string(),
  kind: z.enum(["both-changed", "both-added", "deleted-by-fork", "deleted-by-upstream", "renamed"]),
  stages: z.array(z.number()),
});
const AgentRunSchema = z.object({
  purpose: z.enum(["conflicts", "forbid", "verify"]),
  ok: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  notes: z.string(),
});
const Sha = z.string().regex(/^[0-9a-f]{40,64}$/);

/** A build report read from somewhere else is data from the side that ran untrusted code. */
export const BuildReportSchema = z.object({
  version: z.literal(1),
  fork: Sha,
  target: Sha,
  base: Sha,
  behind: z.number().int().nonnegative(),
  skipped: z
    .object({ outcome: z.enum(["up-to-date", "pending", "waiting"]), summary: z.string() })
    .optional(),
  merge: z
    .object({
      target: Sha,
      commits: z.number().int().nonnegative(),
      build: z.object({
        kind: z.literal("merged"),
        commit: Sha,
        tree: Sha,
        settled: z.array(
          z.object({ path: z.string(), kind: ConflictSchema.shape.kind, by: z.enum(["drop", "ours", "regenerate", "agent"]) }),
        ),
        replayed: z.array(z.string()),
        dropped: z.array(z.string()),
        keptOurs: z.array(z.string()),
        regenerated: z.array(z.object({ command: z.string(), ok: z.boolean() })),
        replaced: z.array(z.object({ file: z.string(), lines: z.number() })),
        gates: z.array(
          z.object({ name: z.string(), ok: z.boolean(), durationMs: z.number(), repaired: z.boolean(), detail: z.string() }),
        ),
        agentRuns: z.array(AgentRunSchema),
      }),
    })
    .optional(),
  openConflicts: z.array(ConflictSchema).optional(),
  agentRuns: z.array(AgentRunSchema),
});

interface State {
  /** The last sync that stopped at a conflict: where the fork was, and which upstream commit stopped it. */
  failure?: { fork: string; blocker: string | null; at: string };
}

async function readState(stateDir: string): Promise<State> {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as State;
  } catch {
    return {};
  }
}

async function writeState(stateDir: string, state: State): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
}

async function commitTime(cwd: string, commit: string): Promise<number> {
  return Number((await git(cwd, ["log", "-1", "--format=%ct", commit])).stdout.trim()) * 1000;
}

/**
 * Build the merge of upstream into the fork: all of it if possible, or the
 * part before the first conflict nobody could settle. Pushes nothing and
 * needs no credentials that can. The result is written to `options.out`.
 */
export async function runBuild(context: Context, options: BuildOptions): Promise<BuildReport> {
  const report = await build(context, options);
  // The merged tree exists only in the workspace, so that is where it is
  // packed up from; a report with no merge needs nothing from there.
  const env = buildEnv(identityEnv(defaultIdentity()));
  await writeHandoff(report.merge ? workspaceDir(context.repo) : context.repo.root, report, options.out, env);
  return report;
}

async function build(context: Context, options: BuildOptions): Promise<BuildReport> {
  const log = options.log ?? (() => {});
  const { repo, branch, fork, config, rules, target, base, behind } = context;
  const cwd = repo.root;
  const stateDir = path.join(repo.commonDir, "forklift");
  const report: BuildReport = { version: 1, fork, target, base, behind, agentRuns: [] };
  const skip = (outcome: "up-to-date" | "pending" | "waiting", summary: string): BuildReport => ({
    ...report,
    skipped: { outcome, summary },
  });

  if (behind === 0) return skip("up-to-date", `${branch} already has everything from ${context.upstream.name}.`);
  log(`${branch} is ${behind} commit${behind === 1 ? "" : "s"} behind ${context.upstream.name}`);
  const retryAfter = parseDuration(config.retry_after);

  // An earlier proposal that nobody has merged yet.
  const proposal = options.fresh ? null : await context.proposal();
  if (proposal && !(await isAncestor(cwd, proposal, fork))) {
    const made = await trailers(cwd, proposal);
    if (!made.upstream) {
      return skip(
        "pending",
        `${config.sync_branch} has commits Forklift did not make. Merge it or delete it, and Forklift carries on.`,
      );
    }
    if (await isAncestor(cwd, fork, proposal)) {
      if (made.status !== "needs-review") {
        return skip("pending", `A sync is already proposed on ${config.sync_branch} and waiting to be merged.`);
      }
      if (Date.now() - (await commitTime(cwd, proposal)) < retryAfter) {
        return skip("waiting", `The last sync needs review on ${config.sync_branch}; trying again after ${config.retry_after}.`);
      }
    }
  }

  const worktree = workspaceDir(repo);
  const buildFor = (to: string, commits: number): Promise<Build> =>
    buildMerge({
      repo,
      config,
      rules,
      worktree,
      base,
      fork,
      target: to,
      upstreamName: context.upstream.name,
      commits,
      useAgent: !options.noAgent,
      log,
    });

  // A conflict that stopped the last sync is not handed to the agent again on
  // every pass: only after `retry_after`, or once somebody has changed the fork.
  const state = await readState(stateDir);
  const predicted = await predict(cwd, fork, target, rules);
  let blocker = predicted.open.length > 0 ? await findBlocker(cwd, fork, target, rules) : null;
  let backingOff = false;
  if (!options.fresh && blocker && state.failure && state.failure.blocker === blocker.commit.sha) {
    const recent = Date.now() - Date.parse(state.failure.at) < retryAfter;
    // The fork moving because Forklift landed the commits before the conflict is not a change by somebody.
    const parent = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${fork}^1`], { allowFailure: true })).stdout.trim();
    const sameFork =
      state.failure.fork === fork ||
      (parent === state.failure.fork && (await trailers(cwd, fork)).upstream !== undefined);
    backingOff = recent && sameFork;
    if (backingOff && state.failure.fork !== fork) {
      await writeState(stateDir, { failure: { ...state.failure, fork } });
    }
  }

  const first = backingOff ? null : await buildFor(target, behind);
  if (first?.kind === "merged") {
    await writeState(stateDir, {});
    return { ...report, merge: { target, commits: behind, build: first } };
  }

  // Conflicts nobody settled. Find the upstream commit responsible, and take
  // everything before it so the fork falls no further behind than it must.
  report.agentRuns = first?.agentRuns ?? [];
  blocker ??= await findBlocker(cwd, fork, target, rules);
  report.openConflicts = first?.open ?? blocker?.conflicts ?? [];
  if (backingOff) {
    report.skipped = {
      outcome: "waiting",
      summary: `Still blocked on upstream commit ${blocker!.commit.sha.slice(0, 10)}; trying again after ${config.retry_after}, or when ${branch} changes.`,
    };
  } else {
    await writeState(stateDir, { failure: { fork, blocker: blocker?.commit.sha ?? null, at: new Date().toISOString() } });
  }

  if (blocker?.lastClean) {
    const commits = await countCommits(cwd, `${fork}..${blocker.lastClean}`);
    if (commits > 0) {
      log(`taking the ${commits} commit${commits === 1 ? "" : "s"} before the first conflict (${blocker.commit.sha.slice(0, 10)})`);
      const prefix = await buildFor(blocker.lastClean, commits);
      if (prefix.kind === "merged") report.merge = { target: blocker.lastClean, commits, build: prefix };
    }
  }
  return report;
}
