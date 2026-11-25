#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  parseDuration,
  runBuildOnly,
  runCheck,
  runInit,
  runPublishOnly,
  runStatus,
  runSync,
  runWatch,
  type Conflict,
  type Outcome,
  type Role,
  type SyncResult,
} from "@forklift/core";
import { ui } from "./ui.js";

const program = new Command();

program
  .name("forklift")
  .description("Heavy lifting for your forks. Keeps a fork up to date with its upstream.")
  .version("0.2.0");

const dir = (cwd?: string): string => path.resolve(cwd ?? process.cwd());
const short = (sha: string): string => sha.slice(0, 10);
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
/** A path relative to where the command was run, unless that would climb out of it. */
const shown = (file: string): string => {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") ? relative : file;
};
const progress = (line: string): void => console.error(ui.dim(`  ${line}`));

const KIND: Record<Conflict["kind"], string> = {
  "both-changed": "changed on both sides",
  "both-added": "added on both sides",
  "deleted-by-fork": "deleted in the fork, changed upstream",
  "deleted-by-upstream": "deleted upstream, changed in the fork",
  renamed: "renamed differently on each side",
};

/** Exit codes: 0 fine, 1 error, 2 a merge needs review, 3 blocked on a conflict, 4 a build was rejected. */
const EXIT: Partial<Record<Outcome, number>> = { "needs-review": 2, blocked: 3, rejected: 4 };

function printSync(result: SyncResult): void {
  const good: Outcome[] = ["up-to-date", "landed", "proposed", "dry-run"];
  const bad: Outcome[] = ["blocked", "needs-review", "rejected"];
  const mark = good.includes(result.outcome) ? ui.ok : bad.includes(result.outcome) ? ui.fail : ui.warn;
  console.log(mark(result.summary));
  for (const breach of result.breaches ?? []) console.log(`  ${ui.red("×")} ${breach}`);
  if (result.outcome === "rejected") return;

  const build = result.build;
  if (build) {
    const by = (who: string) => build.settled.filter((s) => s.by === who).length;
    const parts = [
      by("drop") + build.dropped.length > 0 && `${by("drop") + build.dropped.length} dropped`,
      by("ours") + build.keptOurs.length > 0 && `${by("ours") + build.keptOurs.length} kept as the fork's`,
      build.regenerated.length > 0 && `${build.regenerated.length} regenerated`,
      build.replaced.length > 0 && `${build.replaced.length} rewritten`,
      build.replayed.length > 0 && `${build.replayed.length} replayed`,
      by("agent") > 0 && `${by("agent")} resolved by the agent`,
    ].filter(Boolean);
    if (parts.length > 0) console.log(ui.dim(`  ${parts.join(" · ")}`));
    if (result.judged?.length) {
      const shownPaths = result.judged.slice(0, 6).join(", ");
      const more = result.judged.length > 6 ? ` and ${result.judged.length - 6} more` : "";
      console.log(ui.warn(`to review: ${shownPaths}${more}`));
    }
    for (const gate of build.gates) {
      const line = `${gate.name}${gate.repaired ? " (after the agent's fix)" : ""}`;
      console.log(`  ${gate.ok ? ui.ok(line) : ui.fail(line)}`);
    }
    if (result.outcome === "dry-run" && result.commit) {
      console.log(ui.dim(`  inspect: git show --remerge-diff ${short(result.commit)}`));
    }
  }
  for (const conflict of (result.blocker?.conflicts ?? result.openConflicts ?? []).slice(0, 20)) {
    console.log(`  ${ui.red("×")} ${conflict.path} ${ui.dim(`(${KIND[conflict.kind]})`)}`);
  }
}

program
  .command("init")
  .description("Write a starter forklift.yaml for this fork")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("-u, --upstream <repo>", "upstream, as owner/repo or a git URL (default: the `upstream` remote)")
  .option("--upstream-branch <branch>", "upstream's branch", "main")
  .option("-f, --force", "replace an existing forklift.yaml", false)
  .action(async (opts) => {
    const result = await runInit({
      cwd: dir(opts.cwd),
      upstream: opts.upstream,
      upstreamBranch: opts.upstreamBranch,
      force: opts.force,
    });
    console.log(ui.ok(`Wrote ${shown(result.file)} (upstream: ${result.upstream})`));
    if (result.drop.length > 0) console.log(ui.dim(`  drop: ${plural(result.drop.length, "path")} this fork already deleted`));
    for (const file of Object.keys(result.regenerate)) console.log(ui.dim(`  regenerate: ${file}`));
    console.log(ui.dim(`  agent: ${result.agent ?? "none found; conflicts that need judgement will stop the sync"}`));
    console.log(ui.step("Review it, commit it, then run `forklift status`."));
  });

program
  .command("status")
  .description("Show how far behind upstream the fork is and what a sync would hit")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("--branch <name>", "the fork's branch (default: the one checked out)")
  .option("--remote <name>", "the fork's remote", "origin")
  .option("--config <file>", "read rules from this file instead of the branch")
  .option("--to <commit>", "compare against this upstream commit")
  .option("--no-fetch", "use what is already fetched")
  .option("--json", "print JSON", false)
  .action(async (opts) => {
    const status = await runStatus({
      cwd: dir(opts.cwd),
      branch: opts.branch,
      remote: opts.remote,
      configFile: opts.config,
      to: opts.to,
      noFetch: !opts.fetch,
    });
    if (opts.json) return console.log(JSON.stringify(status, null, 2));

    console.log(`${ui.bold(status.branch)} ${ui.dim(short(status.fork))} ← ${ui.bold(status.upstream.name)} ${ui.dim(`${status.upstream.branch} ${short(status.upstream.commit)}`)}`);
    console.log(
      `  ${status.behind === 0 ? ui.green("up to date") : ui.yellow(`${plural(status.behind, "commit")} behind`)}` +
        ui.dim(` · ${plural(status.ahead, "fork commit")} · ${plural(status.forkFiles, "file")} differ from upstream`),
    );
    if (status.behind === 0) return;

    const { byRule, open } = status.prediction;
    const ruled = byRule.drop.length + byRule.ours.length + byRule.regenerate.length;
    console.log("");
    if (ruled + open.length === 0) {
      console.log(ui.ok("A sync would merge with no conflicts."));
    } else {
      if (ruled > 0) {
        console.log(ui.ok(`${plural(ruled, "conflict")} settled by rules ${ui.dim(`(drop ${byRule.drop.length} · ours ${byRule.ours.length} · regenerate ${byRule.regenerate.length})`)}`));
      }
      if (open.length > 0) {
        console.log(ui.fail(`${plural(open.length, "conflict")} need${open.length === 1 ? "s" : ""} the agent or a person:`));
        for (const conflict of open.slice(0, 25)) console.log(`    ${conflict.path} ${ui.dim(`(${KIND[conflict.kind]})`)}`);
        if (open.length > 25) console.log(ui.dim(`    …and ${open.length - 25} more`));
      }
    }
    if (status.blocker) {
      const b = status.blocker;
      console.log("");
      console.log(ui.step(`First upstream commit that conflicts: ${ui.bold(short(b.commit.sha))} ${b.commit.subject}`));
      console.log(ui.dim(`    ${b.commit.author}, ${b.commit.date.slice(0, 10)} · ${plural(b.cleanBefore, "commit")} before it merge without help`));
    }
    if (status.hotFiles.length > 0) {
      console.log("");
      console.log(ui.dim("Fork-changed files upstream keeps changing (upstream commits since the last sync):"));
      for (const file of status.hotFiles) console.log(ui.dim(`  ${String(file.upstreamCommits).padStart(4)}  ${file.path}`));
    }
  });

program
  .command("check")
  .description("Check the files on disk against the fork's rules (for the fork's own pull requests)")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("--config <file>", "rules file (default: forklift.yaml)")
  .option("--fix", "rewrite text matched by `forbid` rules that have `replace`", false)
  .option("--json", "print JSON", false)
  .action(async (opts) => {
    const result = await runCheck({ cwd: dir(opts.cwd), configFile: opts.config, fix: opts.fix });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const item of result.replaced) console.log(ui.ok(`rewrote ${plural(item.lines, "line")} in ${item.file}`));
      for (const hit of result.hits) {
        console.log(`${ui.red("×")} ${hit.file}:${hit.line} ${ui.dim(`matches /${hit.pattern}/${hit.message ? ` · ${hit.message}` : ""}`)}`);
        console.log(ui.dim(`    ${hit.text}`));
      }
      for (const file of result.present.slice(0, 50)) console.log(`${ui.red("×")} ${file} ${ui.dim("exists but matches `drop`")}`);
      console.log(
        result.ok
          ? ui.ok(`${plural(result.filesScanned, "file")} checked, nothing forbidden.`)
          : ui.fail(`${plural(result.hits.length, "forbidden match", "forbidden matches")}, ${plural(result.present.length, "dropped path")} present.`),
      );
    }
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("sync")
  .description("Merge upstream into the fork, as far as rules, the agent and the checks allow")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("--branch <name>", "the fork's branch (default: the one checked out)")
  .option("--remote <name>", "the fork's remote", "origin")
  .option("--config <file>", "read rules from this file instead of the branch")
  .option("--to <commit>", "merge up to this upstream commit")
  .option("--dry-run", "build the merge locally; push nothing and open nothing", false)
  .option("--pr", "always open a pull request, even when the merge could land directly", false)
  .option("--no-agent", "do not run the agent")
  .option("--retry", "try again now, ignoring the back-off and any open proposal", false)
  .option("--no-fetch", "use what is already fetched")
  .option("--report <file>", "also write the Markdown report to this file")
  .option("--json", "print JSON", false)
  .action(async (opts) => {
    const result = await runSync({
      cwd: dir(opts.cwd),
      branch: opts.branch,
      remote: opts.remote,
      configFile: opts.config,
      to: opts.to,
      dryRun: opts.dryRun,
      pullRequest: opts.pr,
      noAgent: !opts.agent,
      retry: opts.retry,
      noFetch: !opts.fetch,
      log: opts.json ? undefined : progress,
    });
    if (opts.report) await fs.writeFile(path.resolve(opts.report), result.report, "utf8");
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printSync(result);
    process.exitCode = EXIT[result.outcome] ?? 0;
  });

program
  .command("build")
  .description("The first half of a sync: build the merge and write it to a file. Pushes nothing")
  .requiredOption("--out <file>", "where to write the build")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("--branch <name>", "the fork's branch (default: the one checked out)")
  .option("--remote <name>", "the fork's remote", "origin")
  .option("--config <file>", "read rules from this file instead of the branch")
  .option("--to <commit>", "merge up to this upstream commit")
  .option("--no-agent", "do not run the agent")
  .option("--retry", "build now, ignoring the back-off and any open proposal", false)
  .option("--no-fetch", "use what is already fetched")
  .action(async (opts) => {
    const report = await runBuildOnly({
      cwd: dir(opts.cwd),
      out: path.resolve(opts.out),
      branch: opts.branch,
      remote: opts.remote,
      configFile: opts.config,
      to: opts.to,
      noAgent: !opts.agent,
      retry: opts.retry,
      noFetch: !opts.fetch,
      log: progress,
    });
    if (report.skipped) console.log(ui.warn(report.skipped.summary));
    if (report.merge) console.log(ui.ok(`Built a merge of ${plural(report.merge.commits, "upstream commit")}.`));
    if (report.openConflicts) console.log(ui.fail(`${plural(report.openConflicts.length, "conflict")} could not be settled.`));
    console.log(ui.dim(`  wrote ${shown(path.resolve(opts.out))}; publish it with \`forklift publish\``));
  });

program
  .command("publish")
  .description("The second half of a sync: check a build and push it or open a pull request. Runs no code from the fork")
  .argument("<file>", "a build written by `forklift build`")
  .option("-C, --cwd <dir>", "the fork's directory")
  .option("--branch <name>", "the fork's branch (default: the one checked out)")
  .option("--remote <name>", "the fork's remote", "origin")
  .option("--config <file>", "read rules from this file instead of the branch")
  .option("--dry-run", "check the build and keep the result local", false)
  .option("--pr", "always open a pull request", false)
  .option("--report <file>", "also write the Markdown report to this file")
  .option("--json", "print JSON", false)
  .action(async (file: string, opts) => {
    const result = await runPublishOnly({
      cwd: dir(opts.cwd),
      file: path.resolve(file),
      branch: opts.branch,
      remote: opts.remote,
      configFile: opts.config,
      dryRun: opts.dryRun,
      pullRequest: opts.pr,
      log: opts.json ? undefined : progress,
    });
    if (opts.report) await fs.writeFile(path.resolve(opts.report), result.report, "utf8");
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printSync(result);
    process.exitCode = EXIT[result.outcome] ?? 0;
  });

program
  .command("watch")
  .description("Keep one or more forks in sync on a timer (for a server or container)")
  .argument("[repos...]", "forks to sync: owner/repo, a git URL, or a path to a clone (default: $FORKLIFT_REPOS)")
  .option("--every <duration>", "time between passes", process.env.FORKLIFT_EVERY ?? "3h")
  .option("--role <role>", "all (build and publish here), build, or publish", process.env.FORKLIFT_ROLE ?? "all")
  .option("--handoff <dir>", "directory a builder and a publisher share", process.env.FORKLIFT_HANDOFF)
  .option("--once", "run one pass and exit", false)
  .option("--pr", "always open pull requests", false)
  .option("--no-agent", "do not run the agent")
  .option("--dry-run", "build merges locally; push nothing", false)
  .action(async (repos: string[], opts) => {
    const list = repos.length > 0 ? repos : (process.env.FORKLIFT_REPOS ?? "").split(/[\s,]+/).filter(Boolean);
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        console.error(`${signal}: stopping after the current sync`);
        stop.abort();
      });
    }
    const stamp = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
    if (!["all", "build", "publish"].includes(opts.role)) {
      throw new Error(`Unknown role "${opts.role}". Use all, build or publish.`);
    }
    stamp(`forklift watch (${opts.role}): ${plural(list.length, "repository", "repositories")}, every ${opts.every}`);
    await runWatch({
      repos: list,
      everyMs: parseDuration(opts.every),
      once: opts.once,
      role: opts.role as Role,
      handoff: opts.handoff ? path.resolve(opts.handoff) : undefined,
      sync: { dryRun: opts.dryRun, pullRequest: opts.pr, noAgent: !opts.agent },
      log: stamp,
      signal: stop.signal,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(ui.fail(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
