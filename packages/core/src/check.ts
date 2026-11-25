import path from "node:path";
import { CONFIG_FILENAME, compileRules, loadConfigFile } from "./config.js";
import { scanForbidden, type ForbidHit } from "./forbid.js";
import { git, openRepo, splitNul } from "./git.js";

export interface CheckOptions {
  cwd: string;
  configFile?: string;
  /** Rewrite matches of `forbid` rules that have `replace`. */
  fix?: boolean;
}

export interface CheckResult {
  ok: boolean;
  /** Text in the tree that a `forbid` rule does not allow. */
  hits: ForbidHit[];
  /** Files that exist although a `drop` rule says they should not. */
  present: string[];
  replaced: { file: string; lines: number }[];
  filesScanned: number;
}

/**
 * Check the files as they are on disk against the fork's rules. Unlike a
 * sync, which only looks at what a merge brings in, this looks at everything:
 * it is the check to run on the fork's own pull requests.
 */
export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const repo = await openRepo(options.cwd);
  const config = await loadConfigFile(options.configFile ?? path.join(repo.root, CONFIG_FILENAME));
  const rules = compileRules(config);

  const files = splitNul((await git(repo.root, ["ls-files", "-z"])).stdout);
  const scan = await scanForbidden({ dir: repo.root, files, rules: config.forbid, fix: options.fix });
  const present = files.filter(rules.drop);

  return {
    ok: scan.hits.length === 0 && present.length === 0,
    hits: scan.hits,
    present,
    replaced: scan.replaced,
    filesScanned: files.length,
  };
}
