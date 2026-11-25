import fs from "node:fs/promises";
import path from "node:path";
import { BuildReportSchema, type BuildReport } from "./build.js";
import { git, revParse } from "./git.js";

/*
 * A build is handed to the publisher as one file: a git bundle holding the
 * merged tree and the build's report. A bundle is data. Reading it runs
 * nothing from the side that made it, which is the point: the build ran an
 * agent and the fork's commands on unreviewed code, and the publisher holds
 * the credentials that can push.
 */

const MERGE_REF = "refs/forklift/handoff/merge";
const REPORT_REF = "refs/forklift/handoff/report";
const INCOMING = "refs/forklift/incoming";
const REPORT_FILE = "report.json";

/**
 * Pack a build into `file`. `cwd` is the repository that holds the merged
 * tree (the workspace), and `env` the credential-free environment for git
 * commands there.
 */
export async function writeHandoff(
  cwd: string,
  report: BuildReport,
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const run = (args: string[], input?: string) => git(cwd, args, { env, input });
  const blob = (await run(["hash-object", "-w", "--stdin"], JSON.stringify(report))).stdout.trim();
  const tree = (await run(["mktree"], `100644 blob ${blob}\t${REPORT_FILE}\n`)).stdout.trim();
  const carrier = (await run(["commit-tree", tree, "-m", "forklift: build report"])).stdout.trim();
  await run(["update-ref", REPORT_REF, carrier]);

  const args = ["bundle", "create", "--quiet"];
  const tmp = `${file}.tmp-${process.pid}`;
  if (report.merge) {
    await run(["update-ref", MERGE_REF, report.merge.build.commit]);
    // Everything the publisher already has (the fork and upstream) is left out.
    args.push(tmp, REPORT_REF, MERGE_REF, "--not", report.fork, report.merge.target);
  } else {
    await git(cwd, ["update-ref", "-d", MERGE_REF], { allowFailure: true, env });
    args.push(tmp, REPORT_REF);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await run(args);
  // Renamed into place, so a reader never sees half a file.
  await fs.rename(tmp, file);
}

export async function readHandoff(cwd: string, file: string): Promise<BuildReport> {
  await git(cwd, ["update-ref", "-d", `${INCOMING}/merge`], { allowFailure: true });
  await git(cwd, ["update-ref", "-d", `${INCOMING}/report`], { allowFailure: true });
  const fetched = await git(
    cwd,
    ["fetch", "--quiet", "--no-tags", "--force", path.resolve(file), `+refs/forklift/handoff/*:${INCOMING}/*`],
    { allowFailure: true },
  );
  if (fetched.code !== 0) {
    throw new Error(
      `Could not read the build at ${file}. It may have been made for a state of the fork or of upstream this side has not fetched yet. ${fetched.stderr.trim()}`,
    );
  }

  const raw = await git(cwd, ["show", `${INCOMING}/report:${REPORT_FILE}`]);
  const parsed = BuildReportSchema.safeParse(JSON.parse(raw.stdout));
  if (!parsed.success) throw new Error(`The build report in ${file} is not in a form this version understands.`);
  const report = parsed.data as BuildReport;

  if (report.merge) {
    // What the report says it built is replaced by what the bundle actually holds.
    report.merge.build.commit = await revParse(cwd, `${INCOMING}/merge`);
    report.merge.build.tree = (await git(cwd, ["rev-parse", `${INCOMING}/merge^{tree}`])).stdout.trim();
  }
  return report;
}
