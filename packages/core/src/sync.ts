import { exec, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createAiRunner,
  type AiProviderName,
  type AiRunner,
} from "./ai.js";
import { runCheck, type CheckReport } from "./check.js";
import { loadLock, loadManifest, saveLock } from "./config.js";
import {
  countCommits,
  diffNameStatus,
  ensureUpstreamRemote,
  fetchUpstream,
  getCurrentBranch,
  isBinaryBuffer,
  isWorkingTreeClean,
  logOneline,
  mergeFileThreeWay,
  readBlob,
  runGit,
  tryRevParse,
} from "./git.js";
import { createPolicyClassifier, normalizeRepoPath } from "./policy.js";
import { formatSyncPrTitle, formatSyncReport } from "./report.js";
import type { ForkliftLock, ForkliftManifest } from "./schema.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface LiftedFileRecord {
  file: string;
  hookIds: string[];
  summary: string;
  provider: string;
}

export interface ReviewFileRecord {
  file: string;
  reason: string;
}

export interface GeneratedRunRecord {
  paths: string[];
  run: string;
  ok: boolean;
  output: string;
}

export interface VerifyRunRecord {
  name: string;
  run: string;
  ok: boolean;
  durationMs: number;
  repairedByAi: boolean;
  output: string;
}

export interface SyncOptions {
  cwd: string;
  dryRun?: boolean;
  createPr?: boolean;
  skipFetch?: boolean;
  skipVerify?: boolean;
  targetRef?: string;
  branch?: string;
  aiProvider?: AiProviderName;
  aiModel?: string;
  aiRunner?: AiRunner;
  onProgress?: (message: string) => void;
}

export interface SyncResult {
  upToDate: boolean;
  dryRun: boolean;
  upstreamRepo: string;
  upstreamRef: string;
  baseSha: string;
  targetSha: string;
  branchName: string | null;
  commitsCount: number;
  recentCommits: string[];
  cleanFiles: string[];
  ownedShielded: string[];
  droppedKept: string[];
  liftedFiles: LiftedFileRecord[];
  reviewFiles: ReviewFileRecord[];
  generatedRuns: GeneratedRunRecord[];
  verifyResults: VerifyRunRecord[];
  checkReport: CheckReport;
  readyToMerge: boolean;
  prUrl: string | null;
  reportMarkdown: string;
}

async function runShell(
  cwd: string,
  command: string,
): Promise<{ ok: boolean; output: string; durationMs: number }> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      ok: true,
      output: `${stdout}${stderr}`.trim(),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.trim(),
      durationMs: Date.now() - start,
    };
  }
}

async function writeFileEnsuringDir(
  absPath: string,
  content: Buffer | string,
): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}

async function readLocalFile(absPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absPath);
  } catch {
    return null;
  }
}

async function openOrUpdatePullRequest(options: {
  cwd: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  labels: string[];
  draft: boolean;
}): Promise<string> {
  const { cwd, branchName, baseBranch, title, body, labels, draft } = options;

  // Check if an open PR already exists for this branch
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", branchName, "--json", "url,state"],
      { cwd },
    );
    const parsed = JSON.parse(stdout) as { url?: string; state?: string };
    if (parsed.url && parsed.state === "OPEN") {
      await execFileAsync(
        "gh",
        ["pr", "edit", branchName, "--title", title, "--body", body],
        { cwd },
      );
      return parsed.url;
    }
  } catch {
    // No existing PR for this branch
  }

  const args = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branchName,
    "--title",
    title,
    "--body",
    body,
  ];
  if (draft) args.push("--draft");
  for (const label of labels) {
    args.push("--label", label);
  }

  try {
    const { stdout } = await execFileAsync("gh", args, { cwd });
    return stdout.trim();
  } catch (err) {
    // Retry without labels in case repo doesn't have the configured labels yet
    if (labels.length > 0) {
      const retryArgs = [
        "pr",
        "create",
        "--base",
        baseBranch,
        "--head",
        branchName,
        "--title",
        title,
        "--body",
        body,
        ...(draft ? ["--draft"] : []),
      ];
      const { stdout } = await execFileAsync("gh", retryArgs, { cwd });
      return stdout.trim();
    }
    throw err;
  }
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const {
    cwd,
    dryRun = false,
    createPr = false,
    skipFetch = false,
    skipVerify = false,
    onProgress = () => {},
  } = options;

  const manifest: ForkliftManifest = await loadManifest(cwd);
  const lock: ForkliftLock = await loadLock(cwd);
  const { remote, repo, ref } = manifest.upstream;

  if (!dryRun && !(await isWorkingTreeClean(cwd))) {
    throw new Error(
      "Working tree has uncommitted changes. Commit or stash them before running `forklift sync`.",
    );
  }

  // Stage 1: Fetch & resolve target SHA
  let targetSha: string;
  if (options.targetRef) {
    const resolved = await tryRevParse(cwd, options.targetRef);
    if (!resolved) {
      throw new Error(`Could not resolve target ref "${options.targetRef}".`);
    }
    targetSha = resolved;
  } else if (skipFetch) {
    const resolved = await tryRevParse(cwd, `${remote}/${ref}`);
    if (!resolved) {
      throw new Error(
        `Upstream ref "${remote}/${ref}" not found locally. Run without --skip-fetch.`,
      );
    }
    targetSha = resolved;
  } else {
    onProgress(`Fetching ${repo}@${ref}...`);
    await ensureUpstreamRemote(cwd, remote, repo);
    targetSha = await fetchUpstream(cwd, remote, ref);
  }

  const baseSha = lock.upstream.sha;
  const emptyCheck: CheckReport = {
    ok: true,
    brandLeaks: [],
    brandLeaksFixed: 0,
    touchpointDrift: [],
    droppedPresent: [],
    errorCount: 0,
    warningCount: 0,
  };

  if (baseSha === targetSha) {
    const upToDateResult: SyncResult = {
      upToDate: true,
      dryRun,
      upstreamRepo: repo,
      upstreamRef: ref,
      baseSha,
      targetSha,
      branchName: null,
      commitsCount: 0,
      recentCommits: [],
      cleanFiles: [],
      ownedShielded: [],
      droppedKept: [],
      liftedFiles: [],
      reviewFiles: [],
      generatedRuns: [],
      verifyResults: [],
      checkReport: emptyCheck,
      readyToMerge: true,
      prUrl: null,
      reportMarkdown: "",
    };
    return upToDateResult;
  }

  const [commitsCount, recentCommits, upstreamDiffs] = await Promise.all([
    countCommits(cwd, baseSha, targetSha),
    logOneline(cwd, baseSha, targetSha, { limit: 20 }),
    diffNameStatus(cwd, baseSha, targetSha),
  ]);

  onProgress(
    `Lifting ${commitsCount} commits (${baseSha.slice(0, 7)}..${targetSha.slice(0, 7)}) across ${upstreamDiffs.length} changed files...`,
  );

  const originalBranch = await getCurrentBranch(cwd);
  const shortTarget = targetSha.slice(0, 7);
  const branchName =
    options.branch ?? `${manifest.sync.branch_prefix}${shortTarget}`;

  if (!dryRun && (createPr || options.branch)) {
    const branchExists = await tryRevParse(cwd, branchName);
    if (branchExists) {
      await runGit(cwd, ["checkout", branchName]);
    } else {
      await runGit(cwd, ["checkout", "-b", branchName]);
    }
  }

  const classifier = createPolicyClassifier(manifest);
  const cleanFiles: string[] = [];
  const ownedShielded: string[] = [];
  const droppedKept: string[] = [];
  const liftedFiles: LiftedFileRecord[] = [];
  const reviewFiles: ReviewFileRecord[] = [];
  const changedPathsForTriggers = upstreamDiffs.map((d) =>
    normalizeRepoPath(d.path),
  );

  let lazyAiRunner: AiRunner | null = options.aiRunner ?? null;
  const getAiRunner = async (): Promise<AiRunner> => {
    if (!lazyAiRunner) {
      lazyAiRunner = await createAiRunner({
        provider: options.aiProvider,
        model: options.aiModel,
      });
    }
    return lazyAiRunner;
  };

  // Stage 2 & 3: Apply path policy, deterministic 3-way merge, and surgical AI lift
  for (const entry of upstreamDiffs) {
    const file = normalizeRepoPath(entry.path);
    const absPath = path.join(cwd, file);
    const cls = classifier.classify(file);

    if (cls.kind === "owned") {
      ownedShielded.push(file);
      continue;
    }

    if (cls.kind === "dropped") {
      droppedKept.push(file);
      if (!dryRun) {
        await fs.rm(absPath, { force: true });
      }
      continue;
    }

    if (cls.kind === "generated") {
      // Handled deterministically in Stage 4
      continue;
    }

    const baseBlob = await readBlob(cwd, baseSha, file);
    const theirsBlob =
      entry.status === "D" ? null : await readBlob(cwd, targetSha, file);
    const oursBlob = await readLocalFile(absPath);

    const forkModified =
      (baseBlob === null && oursBlob !== null) ||
      (baseBlob !== null && oursBlob === null) ||
      (baseBlob !== null && oursBlob !== null && !baseBlob.equals(oursBlob));

    // Fast path: fork did not touch this file — apply upstream cleanly (0 LLM)
    if (!forkModified) {
      cleanFiles.push(file);
      if (!dryRun) {
        if (theirsBlob === null) {
          await fs.rm(absPath, { force: true });
        } else {
          await writeFileEnsuringDir(absPath, theirsBlob);
        }
      }
      continue;
    }

    // Fork deleted a file that upstream modified — keep deleted unless hooked
    if (oursBlob === null && cls.kind === "upstream") {
      reviewFiles.push({
        file,
        reason: "Deleted in fork while modified upstream (kept deleted)",
      });
      continue;
    }

    const hooks = cls.kind === "hook" ? cls.hooks : [];

    // Binary conflict — cannot text-merge
    if (
      (oursBlob && isBinaryBuffer(oursBlob)) ||
      (theirsBlob && isBinaryBuffer(theirsBlob))
    ) {
      reviewFiles.push({
        file,
        reason: "Binary file modified in both fork and upstream (kept fork version)",
      });
      continue;
    }

    // Upstream deleted a file that the fork modified/hooked -> AI lift
    if (theirsBlob === null && oursBlob !== null) {
      if (dryRun) {
        liftedFiles.push({
          file,
          hookIds: hooks.map((h) => h.id),
          summary: "Would invoke AI lift (deleted upstream, modified in fork)",
          provider: "dry-run",
        });
        continue;
      }

      onProgress(`Lifting ${file} (deleted upstream, modified in fork)...`);
      const runner = await getAiRunner();
      const fileCommits = await logOneline(cwd, baseSha, targetSha, {
        filePath: file,
        limit: 8,
      });
      const lift = await runner.resolveConflict({
        cwd,
        filePath: file,
        hooks,
        baseContent: baseBlob ? baseBlob.toString("utf8") : null,
        oursContent: oursBlob.toString("utf8"),
        theirsContent: null,
        conflictContent: "(Upstream deleted this file while fork modified it.)",
        upstreamCommits: fileCommits,
        upstreamDeleted: true,
      });
      if (lift.content === null) {
        await fs.rm(absPath, { force: true });
      } else {
        await writeFileEnsuringDir(absPath, lift.content);
      }
      liftedFiles.push({
        file,
        hookIds: hooks.map((h) => h.id),
        summary: lift.summary,
        provider: lift.provider,
      });
      reviewFiles.push({
        file,
        reason: "Upstream deleted this file; verify AI resolution",
      });
      continue;
    }

    // Both fork and upstream have text content -> try deterministic 3-way merge first!
    if (oursBlob !== null && theirsBlob !== null) {
      const mergeRes = await mergeFileThreeWay(
        oursBlob,
        baseBlob ?? Buffer.alloc(0),
        theirsBlob,
      );

      // Check if any declared hook anchors vanished in upstream
      const missingAnchors: string[] = [];
      const theirsText = theirsBlob.toString("utf8");
      for (const hook of hooks) {
        for (const anchor of hook.anchors ?? []) {
          if (!theirsText.includes(anchor)) {
            missingAnchors.push(`${hook.id}:${anchor}`);
          }
        }
      }

      if (mergeRes.clean && missingAnchors.length === 0) {
        cleanFiles.push(file);
        if (!dryRun) {
          await writeFileEnsuringDir(absPath, mergeRes.merged);
        }
        if (hooks.some((h) => h.review === "always")) {
          reviewFiles.push({
            file,
            reason: `Hook review=always (${hooks.map((h) => h.id).join(", ")})`,
          });
        }
        continue;
      }

      // Conflict or missing hook anchor -> invoke surgical AI lift
      if (dryRun) {
        liftedFiles.push({
          file,
          hookIds: hooks.map((h) => h.id),
          summary:
            missingAnchors.length > 0
              ? `Would invoke AI lift (missing anchors: ${missingAnchors.join(", ")})`
              : `Would invoke AI lift (${mergeRes.conflictCount} conflict region(s))`,
          provider: "dry-run",
        });
        continue;
      }

      onProgress(
        `Lifting ${file}${hooks.length > 0 ? ` [${hooks.map((h) => h.id).join(", ")}]` : ""}...`,
      );
      const runner = await getAiRunner();
      const fileCommits = await logOneline(cwd, baseSha, targetSha, {
        filePath: file,
        limit: 8,
      });
      const lift = await runner.resolveConflict({
        cwd,
        filePath: file,
        hooks,
        baseContent: baseBlob ? baseBlob.toString("utf8") : null,
        oursContent: oursBlob.toString("utf8"),
        theirsContent: theirsText,
        conflictContent: mergeRes.merged.toString("utf8"),
        upstreamCommits: fileCommits,
        upstreamDeleted: false,
      });

      if (lift.content !== null) {
        await writeFileEnsuringDir(absPath, lift.content);
      }
      liftedFiles.push({
        file,
        hookIds: hooks.map((h) => h.id),
        summary: lift.summary,
        provider: lift.provider,
      });
      if (hooks.some((h) => h.review === "always") || missingAnchors.length > 0) {
        reviewFiles.push({
          file,
          reason:
            missingAnchors.length > 0
              ? `Upstream refactored anchor(s): ${missingAnchors.join(", ")}`
              : `Hook review=always (${hooks.map((h) => h.id).join(", ")})`,
        });
      }
    }
  }

  // Stage 4: Generated artifacts, guardrails, verification, lockfile, PR
  const generatedRuns: GeneratedRunRecord[] = [];
  const triggeredGenerated = classifier.matchingGeneratedRules(
    changedPathsForTriggers,
  );
  if (!dryRun) {
    for (const rule of triggeredGenerated) {
      onProgress(`Regenerating ${rule.paths.join(", ")}...`);
      const res = await runShell(cwd, rule.run);
      generatedRuns.push({
        paths: rule.paths,
        run: rule.run,
        ok: res.ok,
        output: res.output,
      });
    }
  }

  const nextLock: ForkliftLock = {
    version: 1,
    upstream: {
      repo,
      ref,
      sha: targetSha,
      synced_at: new Date().toISOString(),
    },
  };

  if (!dryRun) {
    await saveLock(cwd, nextLock);
  }

  // Run guardrails (with autofix for safe brand leaks)
  const checkReport = dryRun
    ? emptyCheck
    : await runCheck({
        cwd,
        manifest,
        lock: nextLock,
        fix: true,
      });

  // Run verification gates
  const verifyResults: VerifyRunRecord[] = [];
  if (!dryRun && !skipVerify) {
    for (const gate of manifest.verify) {
      onProgress(`Verifying ${gate.name} (${gate.run})...`);
      let res = await runShell(cwd, gate.run);
      let repairedByAi = false;

      if (!res.ok && gate.agent_fix) {
        onProgress(`Verification "${gate.name}" failed; attempting AI repair...`);
        const runner = await getAiRunner();
        const repair = await runner.repairVerification({
          cwd,
          gateName: gate.name,
          command: gate.run,
          output: res.output,
          changedFiles: [...cleanFiles, ...liftedFiles.map((l) => l.file)],
        });
        if (repair.fixed) {
          res = await runShell(cwd, gate.run);
          repairedByAi = res.ok;
        }
      }

      verifyResults.push({
        name: gate.name,
        run: gate.run,
        ok: res.ok,
        durationMs: res.durationMs,
        repairedByAi,
        output: res.output,
      });
    }
  }

  const allGeneratedOk = generatedRuns.every((g) => g.ok);
  const allVerifyOk = verifyResults.every((v) => v.ok);
  const readyToMerge =
    allGeneratedOk &&
    allVerifyOk &&
    checkReport.ok &&
    reviewFiles.length === 0;

  const result: SyncResult = {
    upToDate: false,
    dryRun,
    upstreamRepo: repo,
    upstreamRef: ref,
    baseSha,
    targetSha,
    branchName: dryRun ? null : createPr || options.branch ? branchName : originalBranch,
    commitsCount,
    recentCommits,
    cleanFiles,
    ownedShielded,
    droppedKept,
    liftedFiles,
    reviewFiles,
    generatedRuns,
    verifyResults,
    checkReport,
    readyToMerge,
    prUrl: null,
    reportMarkdown: "",
  };

  result.reportMarkdown = formatSyncReport(result);

  if (!dryRun && createPr) {
    onProgress(`Committing & opening Sync PR on ${branchName}...`);
    await runGit(cwd, ["add", "-A"]);
    const statusRes = await runGit(cwd, ["status", "--porcelain"]);
    if (statusRes.stdout.trim().length > 0) {
      const title = formatSyncPrTitle(manifest.sync.pr.title, shortTarget);
      await runGit(cwd, ["commit", "-m", title]);
    }
    await runGit(cwd, ["push", "-u", "origin", branchName, "--force-with-lease"]);
    const title = formatSyncPrTitle(manifest.sync.pr.title, shortTarget);
    result.prUrl = await openOrUpdatePullRequest({
      cwd,
      branchName,
      baseBranch: originalBranch,
      title,
      body: result.reportMarkdown,
      labels: manifest.sync.pr.labels,
      draft: manifest.sync.pr.draft_on_issue && !readyToMerge,
    });
  }

  return result;
}
