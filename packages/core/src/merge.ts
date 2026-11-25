import fs from "node:fs/promises";
import path from "node:path";
import { conflictPrompt, repairPrompt, runAgent, type AgentRun, type MergeContext } from "./agent.js";
import { CONFIG_FILENAME, parseDuration, type Config, type Rules } from "./config.js";
import { buildEnv, sh, tail } from "./exec.js";
import { describeHits, scanForbidden } from "./forbid.js";
import {
  RENAME_LIMIT,
  defaultIdentity,
  git,
  gitWithPaths,
  identityEnv,
  prepareWorkspace,
  splitNul,
  unmergedPaths,
  type Conflict,
  type GitOptions,
  type Repo,
} from "./git.js";

export interface SettledConflict {
  path: string;
  kind: Conflict["kind"];
  by: "drop" | "ours" | "regenerate" | "agent";
}

export interface Gate {
  name: string;
  ok: boolean;
  durationMs: number;
  /** True when it failed first and passed after the agent changed the code. */
  repaired: boolean;
  /** The end of the output, kept for failures. */
  detail: string;
}

export interface BuildInput {
  repo: Repo;
  config: Config;
  rules: Rules;
  /** Forklift's workspace for this repository (see prepareWorkspace). */
  worktree: string;
  base: string;
  fork: string;
  target: string;
  upstreamName: string;
  commits: number;
  useAgent: boolean;
  log: (line: string) => void;
}

/**
 * A finished merge and the builder's own account of how it got there.
 *
 * Only `tree` is taken at face value by whoever publishes it, and even that
 * is checked against the rules again (inspect.ts). The rest is the builder's
 * word: useful for the report, never the basis for landing something.
 */
export interface MergedBuild {
  kind: "merged";
  /** A commit holding the result. A carrier: the published commit is made by the publisher. */
  commit: string;
  tree: string;
  settled: SettledConflict[];
  /** Conflicts git settled by replaying a resolution recorded on an earlier run. */
  replayed: string[];
  /** New upstream files removed because they match `drop`. */
  dropped: string[];
  /** Upstream changes discarded because the file matches `ours`. */
  keptOurs: string[];
  regenerated: { command: string; ok: boolean }[];
  replaced: { file: string; lines: number }[];
  gates: Gate[];
  agentRuns: AgentRun[];
}

export interface ConflictedBuild {
  kind: "conflicts";
  open: Conflict[];
  settled: SettledConflict[];
  agentRuns: AgentRun[];
}

export type Build = MergedBuild | ConflictedBuild;

export const CONFLICT_MARKERS = /^(<{7}|>{7}) /m;

async function fileState(file: string): Promise<"missing" | "conflicted" | "clean"> {
  let content: Buffer;
  try {
    content = await fs.readFile(file);
  } catch {
    return "missing";
  }
  return CONFLICT_MARKERS.test(content.toString("utf8")) ? "conflicted" : "clean";
}

/**
 * Merge `target` into `fork` in Forklift's workspace and take it as far as it
 * will go: rules, then the agent, then the checks. Ends either with a merged
 * tree (passing its checks or not) or with the conflicts nobody could settle.
 *
 * The workspace is where the agent and the fork's own commands run, on code
 * nobody on the fork has reviewed. So every git command here runs without
 * credentials, and after each of those steps the workspace is put back under
 * the fork's rules instead of being trusted to have stayed there.
 */
export async function buildMerge(input: BuildInput): Promise<Build> {
  const { config, rules, worktree, fork, target, log } = input;
  const env = buildEnv(identityEnv(defaultIdentity()));
  const wgit = (args: string[], options: GitOptions = {}) => git(worktree, args, { ...options, env });
  const withPaths = (args: string[], paths: string[]) => gitWithPaths(worktree, args, paths, { env });

  const ctx: MergeContext = {
    worktree,
    env,
    base: input.base,
    fork,
    target,
    upstreamName: input.upstreamName,
    commits: input.commits,
  };
  const canUseAgent = input.useAgent && config.agent !== undefined;
  const agentRuns: AgentRun[] = [];
  const settled: SettledConflict[] = [];

  await prepareWorkspace(input.repo, worktree, fork, env);
  // Kept inside the workspace's .git: out of the merge, and not a path into the main repository.
  const promptDir = path.join(worktree, ".git", "forklift");

  const merge = await wgit(
    [
      "-c", "rerere.enabled=true",
      "-c", "rerere.autoupdate=true",
      "-c", "merge.conflictStyle=zdiff3",
      "-c", `merge.renameLimit=${RENAME_LIMIT}`,
      "merge", "--no-ff", "--no-commit", "--no-verify", target,
    ],
    { allowFailure: true },
  );
  const merging = await wgit(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFailure: true });
  if (merging.code !== 0) {
    throw new Error(`git merge could not start: ${(merge.stderr || merge.stdout).trim()}`);
  }
  const replayed = [...`${merge.stdout}\n${merge.stderr}`.matchAll(
    /^(?:Resolved|Staged) '(.+)' using previous resolution\.$/gm,
  )].map((m) => m[1]!);

  // 1. Conflicts a rule settles.
  const regenerate = new Set<string>();
  const remove: string[] = [];
  const takeFork: string[] = [];
  const takeUpstream: string[] = [];
  for (const conflict of await unmergedPaths(worktree, { env })) {
    const rule = rules.ruleFor(conflict.path);
    if (!rule) continue;
    settled.push({ path: conflict.path, kind: conflict.kind, by: rule });
    const inFork = conflict.stages.includes(2);
    const inUpstream = conflict.stages.includes(3);
    if (rule === "drop") remove.push(conflict.path);
    else if (rule === "ours") (inFork ? takeFork : remove).push(conflict.path);
    else {
      regenerate.add(rules.regenerate(conflict.path)!);
      (inUpstream ? takeUpstream : inFork ? takeFork : remove).push(conflict.path);
    }
  }
  await withPaths(["rm", "--quiet", "--force", "--ignore-unmatch"], remove);
  await withPaths(["checkout", "--ours"], takeFork);
  await withPaths(["checkout", "--theirs"], takeUpstream);
  await withPaths(["add"], [...takeFork, ...takeUpstream]);

  /** Staged paths that differ from `from`, by kind of change (git's A, M, D, T). */
  const changedSince = async (from: string, kinds: string): Promise<string[]> =>
    splitNul(
      (await wgit(["diff", "--cached", "--no-renames", "--name-only", "-z", `--diff-filter=${kinds}`, from])).stdout,
    );

  // 2. Rules that hold wherever the change came from: git's merge, the agent,
  //    or a command. Applied now and again after each of those has run.
  const dropped = new Set<string>();
  const keptOurs = new Set<string>();
  const enforceRules = async (): Promise<void> => {
    const added = (await changedSince(fork, "A")).filter(rules.drop);
    await withPaths(["rm", "--quiet", "--force", "--ignore-unmatch"], added);
    const taken = (await changedSince(fork, "MDT")).filter((file) => rules.ruleFor(file) === "ours");
    await withPaths(["checkout", fork], taken);
    for (const file of added) dropped.add(file);
    for (const file of taken) keptOurs.add(file);
  };
  await enforceRules();

  /** Stage everything, back under the fork's rules; returns the staged tree. */
  const stage = async (): Promise<string> => {
    await wgit(["add", "-A"]);
    // The fork's config is never upstream's, the agent's or a command's to change.
    const hadConfig = await wgit(["cat-file", "-e", `${fork}:${CONFIG_FILENAME}`], { allowFailure: true });
    if (hadConfig.code === 0) await wgit(["checkout", fork, "--", CONFIG_FILENAME]);
    else await wgit(["rm", "--quiet", "--force", "--ignore-unmatch", "--", CONFIG_FILENAME]);
    await enforceRules();
    return (await wgit(["write-tree"])).stdout.trim();
  };

  /**
   * Undo whatever a command did since `tree`, staged or not, except to the
   * paths `keep` allows. A check must not change the merge, and a command
   * that regenerates a file may change that file and nothing else.
   */
  const restore = async (tree: string, keep: (file: string) => boolean = () => false): Promise<void> => {
    await wgit(["add", "-A"]);
    const back = (await changedSince(tree, "MDT")).filter((file) => !keep(file));
    const gone = (await changedSince(tree, "A")).filter((file) => !keep(file));
    await withPaths(["checkout", tree], back);
    await withPaths(["rm", "--quiet", "--force", "--ignore-unmatch"], gone);
  };

  // 3. Conflicts that need judgement.
  let open = await unmergedPaths(worktree, { env });
  if (open.length > 0) {
    log(`${open.length} conflict${open.length === 1 ? "" : "s"} need judgement`);
    let feedback: string | undefined;
    for (let attempt = 1; canUseAgent && open.length > 0 && attempt <= config.agent!.attempts; attempt++) {
      const before = open;
      const prompt = await conflictPrompt(ctx, config, open, feedback);
      const agentRun = await runAgent(config, worktree, "conflicts", prompt, promptDir, log);
      agentRuns.push(agentRun);
      if (!agentRun.ok) {
        feedback = "The previous run stopped before finishing. Some files may already be resolved; check `git status` and `git diff` and carry on.";
        continue;
      }
      // Stage what the agent left behind; what still has markers stays open.
      const add: string[] = [];
      const gone: string[] = [];
      open = [];
      for (const conflict of before) {
        const state = await fileState(path.join(worktree, conflict.path));
        if (state === "conflicted") open.push(conflict);
        else {
          (state === "missing" ? gone : add).push(conflict.path);
          settled.push({ path: conflict.path, kind: conflict.kind, by: "agent" });
        }
      }
      await withPaths(["add"], add);
      await withPaths(["rm", "--quiet", "--force", "--cached", "--ignore-unmatch"], gone);
      feedback = `These files still contain conflict markers:\n${open.map((c) => `- ${c.path}`).join("\n")}`;
    }
    if (open.length > 0) {
      await wgit(["merge", "--abort"], { allowFailure: true });
      return { kind: "conflicts", open, settled, agentRuns };
    }
  }

  const gates: Gate[] = [];
  const commandTimeout = parseDuration(config.verify_timeout);
  let tree = await stage();

  // 4. Files that are rebuilt, not merged.
  const regenerated: MergedBuild["regenerated"] = [];
  for (const command of regenerate) {
    log(`regenerate: ${command}`);
    const result = await sh(command, { cwd: worktree, env, timeoutMs: commandTimeout });
    await restore(tree, (file) => rules.regenerate(file) === command);
    tree = await stage();
    const ok = result.code === 0 && !result.timedOut;
    regenerated.push({ command, ok });
    if (!ok) {
      gates.push({
        name: `regenerate: ${command}`,
        ok: false,
        repaired: false,
        durationMs: result.durationMs,
        detail: tail(`${result.stdout}\n${result.stderr}`.trim(), 4000),
      });
    }
  }

  /** Let the agent fix a failing check; true when it changed something. */
  const repair = async (purpose: "forbid" | "verify", title: string, detail: string): Promise<boolean> => {
    const agentRun = await runAgent(
      config, worktree, purpose, repairPrompt(ctx, config, { title, detail }), promptDir, log,
    );
    agentRuns.push(agentRun);
    const after = await stage();
    const changed = after !== tree;
    tree = after;
    return agentRun.ok && changed;
  };

  // 5. Text the fork never allows in.
  const replaced: MergedBuild["replaced"] = [];
  if (config.forbid.length > 0) {
    const started = Date.now();
    const scan = async () =>
      scanForbidden({
        dir: worktree,
        files: await changedSince(fork, "AM"),
        rules: config.forbid,
        newSince: fork,
        gitEnv: env,
        fix: true,
      });
    let result = await scan();
    replaced.push(...result.replaced);
    tree = await stage();
    let repaired = false;
    for (let attempt = 1; canUseAgent && result.hits.length > 0 && attempt <= config.agent!.attempts; attempt++) {
      const changed = await repair(
        "forbid",
        "upstream's new code contains text this fork does not allow.",
        describeHits(result.hits),
      );
      if (!changed) break;
      result = await scan();
      tree = await stage();
      repaired = result.hits.length === 0;
    }
    gates.push({
      name: "forbid",
      ok: result.hits.length === 0,
      repaired,
      durationMs: Date.now() - started,
      detail: describeHits(result.hits),
    });
  }

  // 6. The fork's own checks.
  const runStep = async (step: Config["verify"][number]) => {
    log(`verify: ${step.name}`);
    const result = await sh(step.run, { cwd: worktree, env, timeoutMs: commandTimeout });
    await restore(tree);
    return {
      ok: result.code === 0 && !result.timedOut,
      durationMs: result.durationMs,
      output: tail(`${result.stdout}\n${result.stderr}`.trim(), 12_000),
      code: result.timedOut ? "a timeout" : `exit code ${result.code}`,
    };
  };
  let lastRepairedStep = -1;
  for (let index = 0; index < config.verify.length; index++) {
    const step = config.verify[index]!;
    let result = await runStep(step);
    let repaired = false;
    for (let attempt = 1; canUseAgent && !result.ok && attempt <= config.agent!.attempts; attempt++) {
      const changed = await repair("verify", `\`${step.run}\` fails with ${result.code}.`, result.output);
      if (!changed) break;
      result = await runStep(step);
      repaired = result.ok;
    }
    if (repaired) lastRepairedStep = index;
    gates.push({
      name: step.name,
      ok: result.ok,
      repaired,
      durationMs: result.durationMs,
      detail: result.ok ? "" : result.output,
    });
    if (!result.ok) break;
  }
  // A fix for a later check can break an earlier one: confirm those still pass.
  const allPassed = gates.every((g) => g.ok);
  for (let index = 0; allPassed && index < lastRepairedStep; index++) {
    const step = config.verify[index]!;
    const result = await runStep(step);
    if (!result.ok) {
      const gate = gates.find((g) => g.name === step.name)!;
      gate.ok = false;
      gate.detail = `Passed before the agent fixed a later check, and fails after it.\n${result.output}`;
      break;
    }
  }

  // 7. Commit the result here. This commit is a carrier (and what teaches git
  //    to replay these resolutions next time); the commit that gets published
  //    is made afterwards, from this tree, by the side that holds the
  //    credentials.
  tree = await stage();
  await wgit(
    ["-c", "rerere.enabled=true", "commit", "--quiet", "--no-verify", "--allow-empty", "-m",
      `forklift: built merge of ${target.slice(0, 10)} into ${fork.slice(0, 10)}`],
  );
  const commit = (await wgit(["rev-parse", "HEAD"])).stdout.trim();

  return {
    kind: "merged",
    commit,
    tree,
    settled,
    replayed,
    dropped: [...dropped],
    keptOurs: [...keptOurs],
    regenerated,
    replaced,
    gates,
    agentRuns,
  };
}
