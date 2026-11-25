import { loadContext, type ContextOptions } from "./context.js";
import { countCommits, git, splitNul } from "./git.js";
import { findBlocker, predict, type Blocker, type Prediction } from "./plan.js";

export interface StatusResult {
  branch: string;
  fork: string;
  upstream: { name: string; branch: string; commit: string };
  base: string;
  /** Upstream commits the fork does not have. */
  behind: number;
  /** Fork commits upstream does not have. */
  ahead: number;
  /** Files the fork has changed, added or deleted relative to upstream. */
  forkFiles: number;
  /** What merging upstream now would hit. */
  prediction: Prediction;
  /** The first upstream commit that needs an agent or a person, if any. */
  blocker: Blocker | null;
  /**
   * Files the fork has changed that upstream keeps changing too: where this
   * fork's conflicts come from. Most upstream activity first.
   */
  hotFiles: { path: string; upstreamCommits: number }[];
}

export async function runStatus(options: ContextOptions): Promise<StatusResult> {
  const ctx = await loadContext(options);
  const cwd = ctx.repo.root;

  const forkChanged = new Set(
    splitNul((await git(cwd, ["diff", "--no-renames", "--name-only", "-z", ctx.base, ctx.fork])).stdout),
  );

  const touched = new Map<string, number>();
  if (ctx.behind > 0 && forkChanged.size > 0) {
    const { stdout } = await git(cwd, ["log", "--format=", "--name-only", "--no-renames", `${ctx.base}..${ctx.target}`]);
    for (const file of stdout.split("\n")) {
      if (file && forkChanged.has(file)) touched.set(file, (touched.get(file) ?? 0) + 1);
    }
  }
  const hotFiles = [...touched.entries()]
    .filter(([file]) => ctx.rules.ruleFor(file) === null)
    .map(([file, upstreamCommits]) => ({ path: file, upstreamCommits }))
    .sort((a, b) => b.upstreamCommits - a.upstreamCommits || a.path.localeCompare(b.path))
    .slice(0, 15);

  const prediction =
    ctx.behind > 0
      ? await predict(cwd, ctx.fork, ctx.target, ctx.rules)
      : { byRule: { drop: [], regenerate: [], ours: [] }, open: [] };

  return {
    branch: ctx.branch,
    fork: ctx.fork,
    upstream: { name: ctx.upstream.name, branch: ctx.upstream.branch, commit: ctx.target },
    base: ctx.base,
    behind: ctx.behind,
    ahead: await countCommits(cwd, `${ctx.target}..${ctx.fork}`),
    forkFiles: forkChanged.size,
    prediction,
    blocker: prediction.open.length > 0 ? await findBlocker(cwd, ctx.fork, ctx.target, ctx.rules) : null,
    hotFiles,
  };
}
