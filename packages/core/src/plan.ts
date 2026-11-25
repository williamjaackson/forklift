import type { Rules } from "./config.js";
import { commitInfo, git, predictMerge, type CommitInfo, type Conflict } from "./git.js";

export interface Prediction {
  /** Conflicts a rule in forklift.yaml settles without an agent. */
  byRule: { drop: Conflict[]; regenerate: Conflict[]; ours: Conflict[] };
  /** Conflicts that need an agent or a person. */
  open: Conflict[];
}

export function classify(conflicts: Conflict[], rules: Rules): Prediction {
  const prediction: Prediction = { byRule: { drop: [], regenerate: [], ours: [] }, open: [] };
  for (const conflict of conflicts) {
    const rule = rules.ruleFor(conflict.path);
    if (rule) prediction.byRule[rule].push(conflict);
    else prediction.open.push(conflict);
  }
  return prediction;
}

/** What merging `target` into `fork` would hit, computed without a checkout. */
export async function predict(
  cwd: string,
  fork: string,
  target: string,
  rules: Rules,
): Promise<Prediction> {
  return classify(await predictMerge(cwd, fork, target), rules);
}

export interface Blocker {
  /** The first upstream commit whose merge needs an agent or a person. */
  commit: CommitInfo;
  /** How many upstream commits come before it and merge without help. */
  cleanBefore: number;
  /** The last upstream commit that still merges without help, if any. */
  lastClean: string | null;
  conflicts: Conflict[];
}

/**
 * Find the first upstream commit that cannot be merged by rules alone, by
 * bisecting upstream's first-parent history with in-memory merges.
 * Returns null when the whole range merges without help.
 */
export async function findBlocker(
  cwd: string,
  fork: string,
  target: string,
  rules: Rules,
): Promise<Blocker | null> {
  const atTarget = await predict(cwd, fork, target, rules);
  if (atTarget.open.length === 0) return null;

  const { stdout } = await git(cwd, ["rev-list", "--first-parent", "--reverse", `${fork}..${target}`]);
  const commits = stdout.split("\n").filter(Boolean);
  if (commits.length === 0) return null;

  // Invariant: commits[high] is blocked. Find the lowest blocked index.
  let low = 0;
  let high = commits.length - 1;
  let conflicts = atTarget.open;
  while (low < high) {
    const mid = (low + high) >> 1;
    const here = await predict(cwd, fork, commits[mid]!, rules);
    if (here.open.length > 0) {
      high = mid;
      conflicts = here.open;
    } else {
      low = mid + 1;
    }
  }

  return {
    commit: await commitInfo(cwd, commits[low]!),
    cleanBefore: low,
    lastClean: low > 0 ? commits[low - 1]! : null,
    conflicts,
  };
}
