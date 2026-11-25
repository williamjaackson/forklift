import type { AgentRun } from "./agent.js";
import type { ForbidHit } from "./forbid.js";
import type { Conflict } from "./git.js";
import type { MergedBuild } from "./merge.js";
import type { Blocker } from "./plan.js";

export type Outcome =
  /** Nothing upstream that the fork does not already have. */
  | "up-to-date"
  /** Merged into the fork's branch. */
  | "landed"
  /** A pull request is open and every check passes. */
  | "proposed"
  /** A draft pull request is open with a failing check. */
  | "needs-review"
  /** Conflicts neither the rules nor the agent could settle. */
  | "blocked"
  /** An earlier pull request for this fork is still open. */
  | "pending"
  /** A failed sync is being left alone until `retry_after` passes. */
  | "waiting"
  /** The built merge broke the fork's rules, so nothing was published. */
  | "rejected"
  /** Built locally; nothing was pushed. */
  | "dry-run";

export interface ReportView {
  outcome: Outcome;
  branch: string;
  fork: string;
  upstreamName: string;
  upstreamBranch: string;
  /** "owner/repo" when upstream is on GitHub: lets the report link commits. */
  upstreamSlug: string | null;
  /** Upstream commits the fork did not have when the sync started. */
  behind: number;
  /** The merge that was built, if one was. */
  merged?: {
    target: string;
    base: string;
    commits: number;
    /** The merge commit that is published. */
    commit: string;
    /** The builder's account of what it did. */
    build: MergedBuild;
    /** Paths where the result differs from git's own merge in a way no rule accounts for. */
    judged: string[];
    forbidHits: ForbidHit[];
    green: boolean;
    /** The judged paths, as a diff against git's own merge. */
    resolutionDiff: string;
  };
  /** Rules the built merge breaks. */
  breaches?: string[];
  blocker?: Blocker;
  openConflicts?: Conflict[];
  agentRuns: AgentRun[];
  agentConfigured: boolean;
}

const KIND: Record<Conflict["kind"], string> = {
  "both-changed": "changed on both sides",
  "both-added": "added on both sides",
  "deleted-by-fork": "deleted in the fork, changed upstream",
  "deleted-by-upstream": "deleted upstream, changed in the fork",
  renamed: "renamed differently on each side",
};

const sha = (commit: string): string => commit.slice(0, 10);
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function fence(text: string, language = ""): string {
  // A fence longer than any run of backticks inside the text cannot be closed early.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function list(paths: string[], limit = 12): string {
  const shown = paths.slice(0, limit).map((p) => `\`${p}\``);
  return paths.length > limit ? `${shown.join(", ")} and ${paths.length - limit} more` : shown.join(", ");
}

const HEADLINE: Record<Outcome, string> = {
  "up-to-date": "Up to date",
  landed: "Landed",
  proposed: "Ready to merge",
  "needs-review": "Needs review: a check is failing",
  blocked: "Blocked on a conflict",
  pending: "Waiting on an open pull request",
  waiting: "Waiting before trying again",
  rejected: "Rejected: the built merge breaks the fork's rules",
  "dry-run": "Dry run",
};

export function renderReport(view: ReportView): string {
  const out: string[] = [];
  const commitLink = (commit: string): string =>
    view.upstreamSlug
      ? `[\`${sha(commit)}\`](https://github.com/${view.upstreamSlug}/commit/${commit})`
      : `\`${sha(commit)}\``;

  out.push(`**${HEADLINE[view.outcome]}**`, "");

  if (view.breaches?.length) {
    out.push(
      "The merge that was built does not follow `forklift.yaml`, so it was not pushed anywhere. Forklift applies these rules itself while building, so this means something changed the result afterwards: an agent, one of the fork's own commands, or a fault in Forklift.",
      "",
      ...view.breaches.slice(0, 30).map((breach) => `- ${breach}`),
      "",
    );
    return out.join("\n").trimEnd() + "\n";
  }

  if (view.merged) {
    const { build, target, base, commits } = view.merged;
    const range = view.upstreamSlug
      ? `[\`${sha(base)}...${sha(target)}\`](https://github.com/${view.upstreamSlug}/compare/${base}...${target})`
      : `\`${sha(base)}..${sha(target)}\``;
    out.push(
      `Merges ${plural(commits, "commit")} from \`${view.upstreamName}\` (\`${view.upstreamBranch}\`, ${range}) into \`${view.branch}\`.` +
        (commits < view.behind ? ` ${plural(view.behind - commits, "newer commit")} could not be included; see below.` : ""),
      "",
    );

    const did: string[] = [];
    const byRule = (rule: string) => build.settled.filter((s) => s.by === rule).map((s) => s.path);
    const dropConflicts = byRule("drop");
    if (dropConflicts.length + build.dropped.length > 0) {
      did.push(
        `Kept ${plural(dropConflicts.length + build.dropped.length, "path")} out of the fork (\`drop\`): ${list([...dropConflicts, ...build.dropped])}`,
      );
    }
    const oursPaths = [...new Set([...byRule("ours"), ...build.keptOurs])];
    if (oursPaths.length > 0) {
      did.push(`Kept the fork's version of ${plural(oursPaths.length, "file")} (\`ours\`): ${list(oursPaths)}`);
    }
    for (const regen of build.regenerated) {
      did.push(`Regenerated with \`${regen.command}\`${regen.ok ? "" : " (the command failed)"}`);
    }
    if (build.replaced.length > 0) {
      did.push(`Rewrote forbidden text in ${plural(build.replaced.length, "file")}: ${list(build.replaced.map((r) => r.file))}`);
    }
    if (build.replayed.length > 0) {
      did.push(`Replayed ${plural(build.replayed.length, "earlier resolution")}: ${list(build.replayed)}`);
    }
    const agentPaths = byRule("agent");
    if (agentPaths.length > 0) {
      did.push(`The agent resolved ${plural(agentPaths.length, "conflict")}: ${list(agentPaths, 30)}`);
    }
    if (did.length === 0) did.push("Nothing beyond a plain `git merge`: no conflicts and no rules applied.");
    out.push("### What Forklift did", "", ...did.map((line) => `- ${line}`), "");

    // Forbidden text is reported from the publisher's own scan of the result.
    const gates = build.gates.filter((g) => g.name !== "forbid");
    const forbidden = view.merged.forbidHits;
    if (gates.length > 0 || forbidden.length > 0) {
      out.push("### Checks", "");
      for (const gate of gates) {
        const mark = gate.ok ? "✅" : "❌";
        const note = gate.repaired ? " (failed first; passed after the agent's fix)" : "";
        out.push(`- ${mark} \`${gate.name}\` · ${duration(gate.durationMs)}${note}`);
      }
      if (forbidden.length > 0) {
        out.push(`- ❌ \`forbid\` · ${plural(forbidden.length, "match", "matches")} in what the merge brings in`);
      }
      out.push("");
      for (const gate of gates.filter((g) => !g.ok && g.detail)) {
        out.push(details(`Output of <code>${gate.name}</code>`, fence(gate.detail)), "");
      }
      if (forbidden.length > 0) {
        const lines = forbidden
          .slice(0, 40)
          .map((h) => `${h.file}:${h.line}: /${h.pattern}/${h.message ? ` (${h.message})` : ""}\n    ${h.text}`);
        out.push(details("Forbidden text", fence(lines.join("\n"))), "");
      }
    } else {
      out.push("### Checks", "", "- None configured. Add `verify` commands to `forklift.yaml` so merges are tested before they land.", "");
    }

    const notes = view.agentRuns.filter((r) => r.ok && r.notes.trim());
    if (notes.length > 0) {
      out.push("### The agent's notes", "");
      for (const agentRun of notes) {
        out.push(`*${agentRun.purpose}, ${duration(agentRun.durationMs)}*`, "", fence(agentRun.notes.trim()), "");
      }
    }

    const { judged, resolutionDiff, commit } = view.merged;
    if (judged.length > 0) {
      out.push(
        "### What to review",
        "",
        `${plural(judged.length, "file")} in this merge ${judged.length === 1 ? "differs" : "differ"} from what \`git merge\` produced by itself in a way no rule in \`forklift.yaml\` accounts for: ${list(judged, 20)}. Upstream's own changes are not repeated here.`,
        "",
      );
      if (resolutionDiff) {
        const lines = resolutionDiff.split("\n").length;
        const diff =
          resolutionDiff.length > 30_000
            ? `${resolutionDiff.slice(0, 30_000)}\n… cut. Run \`git show --remerge-diff ${sha(commit)}\` for all of it.`
            : resolutionDiff;
        out.push(details(`Resolution diff (${plural(lines, "line")})`, fence(diff, "diff")), "");
      }
    }
  }

  if (view.outcome === "blocked" || view.blocker) {
    const conflicts = view.blocker?.conflicts ?? view.openConflicts ?? [];
    out.push("### What is blocking", "");
    if (view.blocker) {
      const b = view.blocker;
      out.push(
        `The first upstream commit that does not merge is ${commitLink(b.commit.sha)}: **${b.commit.subject}** (${b.commit.author}, ${b.commit.date.slice(0, 10)}).`,
        b.cleanBefore > 0
          ? `The ${plural(b.cleanBefore, "commit")} before it merge without help.`
          : "No upstream commit before it is waiting.",
        "",
      );
    }
    if (conflicts.length > 0) {
      out.push(...conflicts.slice(0, 40).map((c) => `- \`${c.path}\`: ${KIND[c.kind]}`));
      if (conflicts.length > 40) out.push(`- …and ${conflicts.length - 40} more`);
      out.push("");
    }
    const failed = view.agentRuns.filter((r) => r.purpose === "conflicts");
    if (failed.length > 0) {
      out.push(
        `The agent tried ${plural(failed.length, "time")} and did not finish${failed.some((r) => r.timedOut) ? " (it ran out of time)" : ""}.`,
        "",
      );
    } else if (!view.agentConfigured) {
      out.push("No `agent` is configured in `forklift.yaml`, so conflicts that need judgement stop the sync.", "");
    }
    out.push(
      "To get moving again, do any one of these:",
      "",
      `- Merge it by hand: \`git merge ${view.blocker ? sha(view.blocker.commit.sha) : `${view.upstreamName} ${view.upstreamBranch}`}\`, resolve, and push to \`${view.branch}\`.`,
      "- Add a `drop`, `ours` or `regenerate` rule to `forklift.yaml` if one of these paths should always be settled the same way.",
      "- Describe what the fork needs in `notes`, then run `forklift sync --retry`.",
      "",
    );
  }

  if (view.outcome === "proposed" || view.outcome === "needs-review") {
    out.push(
      "---",
      "Merge this with **Create a merge commit**. Squashing or rebasing it cuts the fork off from upstream's history, and every later sync would conflict.",
    );
  }

  return out.join("\n").trimEnd() + "\n";
}
