import { CONFIG_FILENAME, type Config, type Rules } from "./config.js";
import { asText, checkContent, compileForbid, forbidCandidates, type ForbidHit } from "./forbid.js";
import { git, mergeInMemory, readBlobs, splitNul, type Conflict } from "./git.js";
import { CONFLICT_MARKERS } from "./merge.js";

/**
 * What the publishing side works out for itself about a built merge.
 *
 * The build ran an agent and the fork's commands on code nobody has reviewed,
 * so its account of what it did is not evidence. Everything here is derived
 * from git objects alone: no checkout, and no code from the fork or from
 * upstream is run.
 */
export interface Inspection {
  /** Rules the result breaks. A merge with any of these is not published at all. */
  breaches: string[];
  /** Forbidden text the merge would bring into the fork. */
  forbidHits: ForbidHit[];
  /**
   * Paths where the result differs from git's own merge in a way no rule
   * accounts for: an agent's resolution, a regenerated file, anything else.
   * A merge with any of these is one a person should look at.
   */
  judged: string[];
  /** Paths git could not merge by itself. */
  conflicts: Conflict[];
}

export interface InspectInput {
  cwd: string;
  fork: string;
  target: string;
  /** The tree the build produced. */
  tree: string;
  config: Config;
  rules: Rules;
}

/** Beyond this many candidate files, skip explaining them one by one and send the merge to review. */
const MAX_EXPLAINED = 3000;

async function changes(cwd: string, from: string, to: string): Promise<{ kind: string; path: string }[]> {
  const { stdout } = await git(cwd, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to]);
  const parts = splitNul(stdout);
  const list: { kind: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) list.push({ kind: parts[i]!.charAt(0), path: parts[i + 1]! });
  return list;
}

async function blobId(cwd: string, spec: string): Promise<string | null> {
  const res = await git(cwd, ["rev-parse", "--verify", "--quiet", spec], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function inspectMerge(input: InspectInput): Promise<Inspection> {
  const { cwd, fork, target, tree, config, rules } = input;
  const breaches: string[] = [];
  const compiled = compileForbid(config.forbid);

  // The fork's rules cannot be rewritten by the merge that is subject to them.
  if ((await blobId(cwd, `${fork}:${CONFIG_FILENAME}`)) !== (await blobId(cwd, `${tree}:${CONFIG_FILENAME}`))) {
    breaches.push(`${CONFIG_FILENAME} was changed by the merge.`);
  }

  // `drop` and `ours`, against the fork as it is now. Both rules come to the
  // same thing for a path the fork has, or has deleted: the merge leaves it
  // exactly as the fork has it.
  //   drop: nothing may be added, and nothing the fork kept may change.
  //   ours: nothing the fork has may change. A file upstream adds is taken.
  const sinceFork = await changes(cwd, fork, tree);
  const differsFromFork = new Set(sinceFork.map((change) => change.path));
  for (const change of sinceFork) {
    const rule = rules.ruleFor(change.path);
    if (rule === "drop") {
      breaches.push(
        change.kind === "A"
          ? `${change.path} was added, but matches \`drop\`.`
          : `${change.path} was changed, but matches \`drop\`: the fork's copy must stay as it is.`,
      );
    } else if (rule === "ours" && change.kind !== "A") {
      breaches.push(`${change.path} was changed, but matches \`ours\`.`);
    }
  }

  // How the result differs from what git's own merge of the two produces.
  const auto = await mergeInMemory(cwd, fork, target);
  const conflicted = new Set(auto.conflicts.map((c) => c.path));
  const unexplained = (await changes(cwd, auto.tree, tree)).filter((change) => {
    const rule = rules.ruleFor(change.path);
    // A rule accounts for a difference from git's merge only where the result
    // is exactly what the rule dictates: the fork's own entry, untouched.
    // Anything else on such a path (a new file under an `ours` pattern whose
    // content is not what git merged, say) is a judgement like any other.
    const ruled = (rule === "drop" || rule === "ours") && !differsFromFork.has(change.path);
    return !ruled;
  });

  const judged: string[] = [];
  if (unexplained.length > MAX_EXPLAINED) {
    judged.push(...unexplained.map((c) => c.path));
  } else {
    // The one other thing a rule can do to a file is rewrite forbidden text.
    // Redo that rewrite on git's version: if it gives exactly the result, the
    // rule explains the difference; if not, someone or something decided.
    const rewritable = unexplained.filter((c) => c.kind === "M" && !conflicted.has(c.path));
    const blobs = await readBlobs(
      cwd,
      rewritable.flatMap((c) => [`${auto.tree}:${c.path}`, `${fork}:${c.path}`, `${tree}:${c.path}`]),
    );
    const explained = new Set<string>();
    for (const change of rewritable) {
      const merged = asText(blobs.get(`${auto.tree}:${change.path}`));
      const result = asText(blobs.get(`${tree}:${change.path}`));
      if (merged === null || result === null) continue;
      const before = asText(blobs.get(`${fork}:${change.path}`));
      const expected = checkContent(change.path, merged, before, compiled, true);
      if (expected.rewritten > 0 && expected.content === result) explained.add(change.path);
    }
    judged.push(...unexplained.map((c) => c.path).filter((file) => !explained.has(file)));
  }

  // No conflict markers left where git had put them.
  const settledByJudgement = [...conflicted].filter((file) => rules.ruleFor(file) === null);
  const leftovers = await readBlobs(cwd, settledByJudgement.map((file) => `${tree}:${file}`));
  for (const file of settledByJudgement) {
    const text = asText(leftovers.get(`${tree}:${file}`));
    if (text !== null && CONFLICT_MARKERS.test(text)) breaches.push(`${file} still contains conflict markers.`);
  }

  // Forbidden text among what the merge adds to the fork.
  const candidates = forbidCandidates(
    sinceFork.filter((c) => c.kind === "A" || c.kind === "M").map((c) => c.path),
    compiled,
  );
  const added = await readBlobs(cwd, candidates.flatMap((file) => [`${tree}:${file}`, `${fork}:${file}`]));
  const forbidHits: ForbidHit[] = [];
  for (const file of candidates) {
    const text = asText(added.get(`${tree}:${file}`));
    if (text === null) continue;
    forbidHits.push(...checkContent(file, text, asText(added.get(`${fork}:${file}`)), compiled, false).hits);
  }

  return { breaches, forbidHits, judged: [...new Set(judged)].sort(), conflicts: auto.conflicts };
}

const MAX_DIFF_PATHS = 150;

/**
 * What a reviewer needs to read: the judged paths, as a diff against what
 * `git merge` produced by itself. Upstream's own changes are not in it.
 */
export async function resolutionDiff(cwd: string, commit: string, judged: string[]): Promise<string> {
  if (judged.length === 0) return "";
  const shown = judged.slice(0, MAX_DIFF_PATHS);
  const diff = await git(cwd, ["show", "--remerge-diff", "--format=", "--no-color", commit, "--", ...shown], {
    allowFailure: true,
  });
  if (diff.code !== 0) return "";
  const note =
    judged.length > shown.length
      ? `\n(${judged.length - shown.length} more files differ; run \`git show --remerge-diff ${commit.slice(0, 10)}\` to see all.)\n`
      : "";
  return diff.stdout.trim() + note;
}
