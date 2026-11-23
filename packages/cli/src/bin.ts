#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  runCheck,
  runInit,
  runStatus,
  runSync,
  type AiProviderName,
} from "@forklift/core";
import { ui } from "./ui.js";

const program = new Command();

program
  .name("forklift")
  .description("Heavy lifting for your forks. Intent-aware upstream sync engine.")
  .version("0.1.0");

function resolveCwd(dir?: string): string {
  return path.resolve(dir ?? process.cwd());
}

program
  .command("init")
  .description("Initialize forklift.yaml and forklift.lock in a forked repo")
  .option("-C, --cwd <dir>", "Target repository directory")
  .option("-u, --upstream <repo>", "Upstream repo (owner/repo or git URL)")
  .option("--ref <ref>", "Upstream branch or ref", "main")
  .option("--remote <name>", "Git remote name", "upstream")
  .option("--strategy <strategy>", "Sync strategy (squash | merge)", "squash")
  .option("-f, --force", "Overwrite existing forklift.yaml", false)
  .action(async (opts) => {
    const cwd = resolveCwd(opts.cwd);
    const res = await runInit({
      cwd,
      upstream: opts.upstream,
      ref: opts.ref,
      remote: opts.remote,
      strategy: opts.strategy,
      force: opts.force,
    });

    console.log(`${ui.badge("forklift")} Initialized manifest & lockfile`);
    console.log(
      ui.ok(
        `Upstream: ${ui.bold(res.manifest.upstream.repo)}@${res.manifest.upstream.ref} (${res.lock.upstream.sha.slice(0, 7)})`,
      ),
    );
    console.log(
      ui.dim(
        `  owned: ${res.detectedOwned.length} · dropped: ${res.detectedDropped.length} · hooks: ${res.detectedHooks.length} · generated: ${res.detectedGenerated.length}`,
      ),
    );
    console.log(
      ui.step(
        `Next: review ${ui.bold("forklift.yaml")} (add brand_leaks & hook intents), then run ${ui.bold("forklift check")}.`,
      ),
    );
  });

program
  .command("status")
  .description("Show how far behind upstream your fork is and which hooks are affected")
  .option("-C, --cwd <dir>", "Target repository directory")
  .option("--no-fetch", "Skip fetching upstream remote")
  .option("--target <ref>", "Compare against a specific upstream ref or SHA")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const cwd = resolveCwd(opts.cwd);
    const report = await runStatus({
      cwd,
      fetch: opts.fetch,
      targetRef: opts.target,
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      `${ui.badge("forklift")} ${ui.bold(report.upstreamRepo)}@${report.upstreamRef}`,
    );
    if (report.commitsBehind === 0) {
      console.log(
        ui.ok(`Up to date at ${ui.bold(report.lastSyncedSha.slice(0, 7))}.`),
      );
      return;
    }

    console.log(
      ui.step(
        `${ui.bold(String(report.commitsBehind))} commit(s) behind (${report.lastSyncedSha.slice(0, 7)}..${report.targetSha.slice(0, 7)})`,
      ),
    );
    console.log(
      ui.dim(
        `  upstream: ${report.counts.upstream} · hooks: ${report.counts.hooks} · owned: ${report.counts.owned} · dropped: ${report.counts.dropped} · generated: ${report.counts.generated}`,
      ),
    );

    if (report.affectedHooks.length > 0) {
      console.log("");
      console.log(ui.bold("Affected hooks:"));
      for (const item of report.affectedHooks) {
        const anchorWarn =
          item.missingAnchors.length > 0
            ? ui.yellow(
                ` [missing anchors: ${item.missingAnchors.map((a) => a.anchor).join(", ")}]`,
              )
            : "";
        console.log(
          `  ${ui.yellow("•")} ${ui.bold(item.hook.id)} (${item.files.join(", ")})${anchorWarn}`,
        );
      }
    }

    if (report.recentCommits.length > 0) {
      console.log("");
      console.log(ui.bold("Latest upstream commits:"));
      for (const line of report.recentCommits.slice(0, 8)) {
        console.log(`  ${ui.dim(line)}`);
      }
    }
  });

program
  .command("check")
  .description("Run deterministic guardrails (brand leaks, touchpoint drift, dropped paths)")
  .option("-C, --cwd <dir>", "Target repository directory")
  .option("--fix", "Auto-fix safe brand_leaks (mode=autofix) and remove dropped files", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const cwd = resolveCwd(opts.cwd);
    const report = await runCheck({ cwd, fix: opts.fix });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }

    console.log(`${ui.badge("forklift")} Guardrail check`);

    if (report.brandLeaksFixed > 0) {
      console.log(ui.ok(`Auto-fixed ${report.brandLeaksFixed} brand leak(s).`));
    }

    for (const file of report.droppedPresent) {
      console.log(ui.fail(`Dropped path still present: ${ui.bold(file)}`));
    }

    for (const tp of report.touchpointDrift) {
      const msg = `Undeclared touchpoint (${tp.status}): ${ui.bold(tp.file)} — add to owned/dropped/hooks in forklift.yaml`;
      console.log(tp.severity === "error" ? ui.fail(msg) : ui.warn(msg));
    }

    for (const leak of report.brandLeaks) {
      if (leak.fixed) continue;
      const msg = `Brand leak [${leak.ruleId}] ${ui.bold(`${leak.file}:${leak.line}`)} matched "${leak.matched}"`;
      console.log(leak.mode === "warn" ? ui.warn(msg) : ui.fail(msg));
    }

    if (report.ok) {
      const warnSuffix =
        report.warningCount > 0 ? ` (${report.warningCount} warning(s))` : "";
      console.log(ui.ok(`All guardrails passed${warnSuffix}.`));
    } else {
      console.log(
        ui.fail(
          `${report.errorCount} error(s), ${report.warningCount} warning(s).`,
        ),
      );
      process.exitCode = 1;
    }
  });

program
  .command("sync")
  .description("Lift upstream commits into your fork using path policy, intent hooks, and verification")
  .option("-C, --cwd <dir>", "Target repository directory")
  .option("--dry-run", "Preview what would be synced without modifying files", false)
  .option("--pr", "Create/update a sync branch, push, and open a GitHub PR via gh", false)
  .option("--branch <name>", "Override sync branch name")
  .option("--target <ref>", "Sync up to a specific upstream ref or SHA")
  .option("--skip-fetch", "Use already-fetched upstream ref locally", false)
  .option("--skip-verify", "Skip running verify gates", false)
  .option("--ai <provider>", "AI provider (anthropic | openai | claude | codex)")
  .option("--model <model>", "Override AI model name")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const cwd = resolveCwd(opts.cwd);
    const result = await runSync({
      cwd,
      dryRun: opts.dryRun,
      createPr: opts.pr,
      branch: opts.branch,
      targetRef: opts.target,
      skipFetch: opts.skipFetch,
      skipVerify: opts.skipVerify,
      aiProvider: opts.ai as AiProviderName | undefined,
      aiModel: opts.model,
      onProgress: (msg) => {
        if (!opts.json) console.error(ui.step(msg));
      },
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.readyToMerge && !opts.dryRun && !opts.pr) {
        process.exitCode = 1;
      }
      return;
    }

    if (result.upToDate) {
      console.log(
        ui.ok(
          `Already up to date with ${result.upstreamRepo}@${result.upstreamRef} (${result.targetSha.slice(0, 7)}).`,
        ),
      );
      return;
    }

    console.log("");
    console.log(
      `${ui.badge("forklift")} ${result.dryRun ? "Dry run complete" : "Lift complete"} (${result.commitsCount} commits)`,
    );
    console.log(
      ui.ok(
        `${result.cleanFiles.length} clean · ${result.liftedFiles.length} lifted · ${result.ownedShielded.length} owned · ${result.droppedKept.length} dropped · ${result.checkReport.brandLeaksFixed} brand leaks fixed`,
      ),
    );

    for (const lifted of result.liftedFiles) {
      console.log(ui.lift(`${ui.bold(lifted.file)} — ${lifted.summary}`));
    }
    for (const review of result.reviewFiles) {
      console.log(ui.warn(`${ui.bold(review.file)} — ${review.reason}`));
    }
    for (const gate of result.verifyResults) {
      const fn = gate.ok ? ui.ok : ui.fail;
      console.log(
        fn(
          `verify:${gate.name} (${(gate.durationMs / 1000).toFixed(1)}s)${gate.repairedByAi ? " [repaired by AI]" : ""}`,
        ),
      );
    }

    if (result.prUrl) {
      console.log(ui.ok(`Sync PR: ${ui.cyan(result.prUrl)}`));
    }

    if (!result.readyToMerge && !opts.dryRun && !opts.pr) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(ui.fail(message));
  process.exit(1);
});
