import type { AgentRun } from "./agent.js";
import type { BuildReport } from "./build.js";
import { trailers, type Context } from "./context.js";
import { git, identityEnv, isAncestor, type Conflict } from "./git.js";
import type { PullRequest } from "./github.js";
import { inspectMerge, resolutionDiff } from "./inspect.js";
import type { MergedBuild } from "./merge.js";
import { findBlocker, type Blocker } from "./plan.js";
import { renderReport, type Outcome, type ReportView } from "./report.js";

export interface PublishOptions {
  /** Keep the result local: push nothing, open nothing. */
  dryRun?: boolean;
  /** Always open a pull request, even for a merge that could land directly. */
  pullRequest?: boolean;
  log?: (line: string) => void;
}

export interface SyncResult {
  outcome: Outcome;
  /** One line a person can read in a log. */
  summary: string;
  branch: string;
  fork: string;
  upstream: { name: string; branch: string; commit: string };
  /** Upstream commits the fork did not have when the sync started. */
  behind: number;
  /** The merge commit Forklift published or built, if there is one. */
  commit?: string;
  /** How many of the `behind` commits that merge includes. */
  merged?: number;
  /** Where the merge can be found: a branch, or a local ref on a dry run. */
  ref?: string;
  pullRequest?: PullRequest;
  issueUrl?: string;
  blocker?: Blocker;
  openConflicts?: Conflict[];
  /** The builder's account of the merge. */
  build?: MergedBuild;
  /** Paths a person should review: where the merge is not git's own and no rule explains why. */
  judged?: string[];
  /** Rules the built merge broke; set only when it was rejected. */
  breaches?: string[];
  agentRuns: AgentRun[];
  /** Markdown, as posted to the pull request or issue. */
  report: string;
}

const BLOCKED_TITLE = "[Forklift] Upstream sync is blocked";
const DRY_RUN_REF = "refs/forklift/dry-run";

/**
 * Remove a proposal branch whose pull request was closed or merged, so the
 * next build starts afresh instead of waiting on it for ever.
 */
export async function tidyProposal(context: Context): Promise<void> {
  const github = await context.github();
  if (!github) return;
  const proposal = await context.proposal();
  if (!proposal) return;
  const cwd = context.repo.root;
  // A branch with somebody's own commits on it is theirs to deal with.
  if (!(await trailers(cwd, proposal)).upstream) return;
  if (await github.findPullRequest(context.config.sync_branch, context.branch)) return;
  await context.remoteGit(["push", "--quiet", context.remote, "--delete", context.config.sync_branch], {
    allowFailure: true,
  });
  await git(cwd, ["update-ref", "-d", `refs/remotes/${context.remote}/${context.config.sync_branch}`], {
    allowFailure: true,
  });
}

/**
 * Take a build and decide what becomes of it: pushed to the fork's branch,
 * proposed as a pull request, or reported as blocked.
 *
 * This is the side with the credentials, so it runs no code from the fork or
 * from upstream, and it does not take the build's word for anything that
 * matters. It checks the merged tree against the fork's rules itself, works
 * out for itself whether anyone's judgement went into the merge, and makes
 * the merge commit itself.
 */
export async function publish(
  context: Context,
  report: BuildReport,
  options: PublishOptions = {},
): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const { repo, branch, remote, forkUrl, fork, config, rules } = context;
  const cwd = repo.root;
  const upstreamName = context.upstream.name;

  const view: ReportView = {
    outcome: "up-to-date",
    branch,
    fork,
    upstreamName,
    upstreamBranch: context.upstream.branch,
    upstreamSlug: context.upstream.slug,
    behind: context.behind,
    agentRuns: [],
    agentConfigured: config.agent !== undefined,
  };
  const finish = (outcome: Outcome, summary: string, extra: Partial<SyncResult> = {}): SyncResult => {
    view.outcome = outcome;
    return {
      outcome,
      summary,
      branch,
      fork,
      upstream: { name: upstreamName, branch: context.upstream.branch, commit: context.target },
      behind: context.behind,
      agentRuns: view.agentRuns,
      blocker: view.blocker,
      openConflicts: view.openConflicts,
      breaches: view.breaches,
      report: renderReport(view),
      ...extra,
    };
  };

  if (report.fork !== fork) {
    return finish("waiting", `The build on hand was made for an earlier state of ${branch}; waiting for the next one.`);
  }

  const publishing = forkUrl !== null && !options.dryRun;
  const github = publishing ? await context.github() : null;

  if (report.skipped && !report.merge && !report.openConflicts) {
    const waitingOn =
      report.skipped.outcome === "pending" && github
        ? ((await github.findPullRequest(config.sync_branch, branch)) ?? undefined)
        : undefined;
    return finish(report.skipped.outcome, report.skipped.summary, {
      pullRequest: waitingOn,
      ref: report.skipped.outcome === "up-to-date" ? undefined : config.sync_branch,
    });
  }

  // What is in the way, worked out here rather than taken from the build.
  if (report.openConflicts) {
    view.openConflicts = report.openConflicts;
    view.agentRuns.push(...report.agentRuns);
    const end = (await isAncestor(cwd, report.target, context.target)) ? report.target : context.target;
    view.blocker = (await findBlocker(cwd, fork, end, rules)) ?? undefined;
  }

  let landed: { outcome: Outcome; ref: string; commit: string; commits: number; pullRequest?: PullRequest } | undefined;
  if (report.merge) {
    const { target: to, commits, build } = report.merge;
    if (!(await isAncestor(cwd, to, context.target))) {
      view.breaches = [`The build merged ${to.slice(0, 10)}, which is not a commit on ${upstreamName}'s ${context.upstream.branch}.`];
      return finish("rejected", `Rejected the built merge: ${view.breaches[0]}`);
    }

    const inspection = await inspectMerge({ cwd, fork, target: to, tree: build.tree, config, rules });
    if (inspection.breaches.length > 0) {
      view.breaches = inspection.breaches;
      const more = inspection.breaches.length > 1 ? ` (and ${inspection.breaches.length - 1} more)` : "";
      return finish("rejected", `Rejected the built merge, nothing was pushed: ${inspection.breaches[0]}${more}`, { build });
    }

    const judged = inspection.judged;
    const green = build.gates.every((g) => g.ok) && inspection.forbidHits.length === 0;
    const failing = [
      ...build.gates.filter((g) => !g.ok && g.name !== "forbid").map((g) => g.name),
      ...(inspection.forbidHits.length > 0 ? ["forbid"] : []),
    ];
    const message = [
      `Merge upstream ${upstreamName}@${to.slice(0, 10)} into ${branch}`,
      "",
      `Forklift merged ${commits} upstream commit${commits === 1 ? "" : "s"} (${context.base.slice(0, 10)}..${to.slice(0, 10)}).`,
      ...(judged.length > 0
        ? [`${judged.length} file${judged.length === 1 ? "" : "s"} settled by judgement, not by git or a rule.`]
        : []),
      ...(green ? [] : [`Failing checks: ${failing.join(", ")}.`]),
      "",
      `Forklift-Upstream: ${to}`,
      `Forklift-Status: ${green ? (judged.length > 0 ? "resolved" : "clean") : "needs-review"}`,
    ].join("\n");
    const commit = (
      await git(cwd, ["commit-tree", build.tree, "-p", fork, "-p", to, "-F", "-"], {
        input: message,
        env: { ...process.env, ...identityEnv(context.credentials.identity) },
      })
    ).stdout.trim();

    view.merged = {
      target: to,
      base: context.base,
      commits,
      commit,
      build,
      judged,
      forbidHits: inspection.forbidHits,
      green,
      resolutionDiff: await resolutionDiff(cwd, commit, judged),
    };
    view.agentRuns.push(...build.agentRuns);

    const land = async (): Promise<{ outcome: Outcome; ref: string; pullRequest?: PullRequest }> => {
      if (!publishing) {
        await git(cwd, ["update-ref", DRY_RUN_REF, commit]);
        return { outcome: "dry-run", ref: DRY_RUN_REF };
      }

      const mode = judged.length > 0 ? config.land.resolved : config.land.clean;
      if (green && mode === "push" && !options.pullRequest) {
        const push = await context.remoteGit(["push", "--quiet", remote, `${commit}:refs/heads/${branch}`], {
          allowFailure: true,
        });
        if (push.code === 0) {
          // An earlier proposal is now out of date.
          if (await context.proposal()) {
            await context.remoteGit(["push", "--quiet", remote, "--delete", config.sync_branch], { allowFailure: true });
          }
          return { outcome: "landed", ref: branch };
        }
        log(`${remote} did not accept a push to ${branch}; opening a pull request instead`);
      }

      const outcome: Outcome = green ? "proposed" : "needs-review";
      view.outcome = outcome;
      // Publishing the same build twice must change nothing.
      const existing = await context.proposal();
      if (existing) {
        const same = (await git(cwd, ["log", "-1", "--format=%T %P", existing])).stdout.trim();
        if (same === `${build.tree} ${fork} ${to}`) {
          const open = (await github?.findPullRequest(config.sync_branch, branch)) ?? undefined;
          if (open || !github) return { outcome, ref: config.sync_branch, pullRequest: open };
        }
      }
      await context.remoteGit(["push", "--quiet", "--force", remote, `${commit}:refs/heads/${config.sync_branch}`]);
      const pullRequest = await github?.upsertPullRequest({
        head: config.sync_branch,
        base: branch,
        title: `[Forklift] Sync upstream → ${to.slice(0, 7)} (${commits} commit${commits === 1 ? "" : "s"})`,
        body: renderReport(view),
        draft: !green,
      });
      return { outcome, ref: config.sync_branch, pullRequest };
    };
    landed = { ...(await land()), commit, commits };
  }

  const describe = (): string => {
    if (!landed) return "";
    const what = `${landed.commits} upstream commit${landed.commits === 1 ? "" : "s"}`;
    const link = landed.pullRequest?.url ?? landed.ref;
    if (landed.outcome === "landed") return `Landed ${what} on ${branch}.`;
    if (landed.outcome === "proposed") return `Proposed ${what}: ${link}`;
    if (landed.outcome === "needs-review") return `Merged ${what} but a check is failing; needs review: ${link}`;
    return `Built a merge of ${what} at ${landed.ref} (dry run; nothing pushed).`;
  };
  const extra: Partial<SyncResult> = {
    commit: landed?.commit,
    merged: landed?.commits,
    ref: landed?.ref,
    pullRequest: landed?.pullRequest,
    build: report.merge?.build,
    judged: view.merged?.judged,
  };

  if (!report.openConflicts) {
    if (publishing && (landed?.outcome === "landed" || landed?.outcome === "proposed")) {
      await github?.closeIssue(BLOCKED_TITLE, "Forklift got past this: the sync that was blocked has gone through.");
    }
    return finish(landed!.outcome, describe(), extra);
  }

  // Blocked on a conflict. Anything before it has just been published above.
  const stillWaiting = report.skipped?.outcome === "waiting";
  view.outcome = "blocked";
  let issueUrl: string | undefined;
  if (publishing && !stillWaiting) {
    issueUrl = (await github?.upsertIssue(BLOCKED_TITLE, renderReport(view))) ?? undefined;
  }
  const blockedOn = view.blocker
    ? `upstream commit ${view.blocker.commit.sha.slice(0, 10)} (${view.blocker.commit.subject})`
    : `${report.openConflicts.length} conflict${report.openConflicts.length === 1 ? "" : "s"}`;
  const also = landed ? ` ${describe()}` : "";
  if (stillWaiting) return finish("waiting", `${report.skipped!.summary}${also}`, extra);
  return finish("blocked", `Blocked on ${blockedOn}.${also}${issueUrl ? ` Details: ${issueUrl}` : ""}`, {
    ...extra,
    issueUrl,
  });
}
