import { credentialArgs, credentialEnv, resolveCredentials, type Credentials } from "./auth.js";
import {
  CONFIG_FILENAME,
  compileRules,
  githubSlug,
  loadConfigFile,
  parseConfig,
  upstreamUrl,
  type Config,
  type Rules,
} from "./config.js";
import {
  assertGitVersion,
  countCommits,
  currentBranch,
  git,
  mergeBase,
  openRepo,
  remoteUrl,
  revParse,
  showFile,
  tryRevParse,
  type GitOptions,
  type Repo,
} from "./git.js";
import type { RunResult } from "./exec.js";
import { connectGitHub, type GitHub } from "./github.js";

export interface ContextOptions {
  cwd: string;
  /** The fork's branch. Default: the branch checked out in `cwd`. */
  branch?: string;
  /** The fork's remote. Default: `origin`. Without one, the local branch is used. */
  remote?: string;
  /** Read rules from this file instead of forklift.yaml on the fork's branch. */
  configFile?: string;
  /** Compare against this upstream commit instead of the branch tip. */
  to?: string;
  /** Use the refs already fetched. */
  noFetch?: boolean;
}

/** Everything Forklift needs to know before it decides what to do. */
export interface Context {
  repo: Repo;
  branch: string;
  remote: string;
  /** URL of the fork's remote, or null when there is none. */
  forkUrl: string | null;
  /** "owner/repo" when the fork is on GitHub. */
  forkSlug: string | null;
  /** The fork's commit. */
  fork: string;
  config: Config;
  rules: Rules;
  upstream: { name: string; slug: string | null; url: string; branch: string; tip: string };
  /** The upstream commit to merge. */
  target: string;
  /** Common ancestor of `fork` and `target`. */
  base: string;
  /** Upstream commits the fork does not have. */
  behind: number;
  credentials: Credentials;
  /** git, in the repository, with the credentials for the fork's remote. */
  remoteGit: (args: string[], options?: GitOptions) => Promise<RunResult>;
  /** The open proposal branch on the fork's remote, if there is one. */
  proposal: () => Promise<string | null>;
  /** GitHub, when the fork is hosted there and reachable; otherwise null. */
  github: () => Promise<GitHub | null>;
}

export async function loadContext(options: ContextOptions): Promise<Context> {
  await assertGitVersion(options.cwd);
  const repo = await openRepo(options.cwd);
  const cwd = repo.root;

  const branch = options.branch ?? (await currentBranch(cwd)) ?? "main";
  const remote = options.remote ?? "origin";
  const forkUrl = await remoteUrl(cwd, remote);
  const forkSlug = forkUrl ? githubSlug(forkUrl) : null;

  const credentials = await resolveCredentials(forkSlug);
  const remoteGit: Context["remoteGit"] = (args, gitOptions = {}) =>
    git(cwd, [...credentialArgs(credentials, forkUrl), ...args], {
      ...gitOptions,
      env: credentialEnv(credentials),
    });
  const fetch = async (source: string, name: string, tracking: string): Promise<string> => {
    if (!options.noFetch) {
      await remoteGit(["fetch", "--quiet", "--no-tags", source, `+refs/heads/${name}:${tracking}`]);
    }
    return revParse(cwd, tracking);
  };

  const fork = forkUrl
    ? await fetch(remote, branch, `refs/remotes/${remote}/${branch}`)
    : await revParse(cwd, `refs/heads/${branch}`);

  // The rules are read from the branch being synced, so they travel with the
  // fork and a hosted copy needs no configuration of its own.
  let config: Config;
  if (options.configFile) {
    config = await loadConfigFile(options.configFile);
  } else {
    const raw = await showFile(cwd, fork, CONFIG_FILENAME);
    if (raw === null) {
      throw new Error(`No ${CONFIG_FILENAME} on ${branch}. Run \`forklift init\`, commit the file, and push.`);
    }
    config = parseConfig(raw, `${CONFIG_FILENAME} on ${branch}`);
  }

  const url = upstreamUrl(config.upstream.url);
  const slug = githubSlug(url);
  const name = slug ?? url;
  const tip = await fetch(url, config.upstream.branch, `refs/remotes/${config.upstream.remote}/${config.upstream.branch}`);
  const target = options.to ? await revParse(cwd, options.to) : tip;

  const base = await mergeBase(cwd, fork, target);
  if (!base) {
    throw new Error(
      `${branch} and ${name} share no history, so there is nothing to merge from. A fork must start as a clone of upstream.`,
    );
  }

  const proposal: Context["proposal"] = async () => {
    if (!forkUrl) return null;
    const tracking = `refs/remotes/${remote}/${config.sync_branch}`;
    if (!options.noFetch) {
      const fetched = await remoteGit(
        ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${config.sync_branch}:${tracking}`],
        { allowFailure: true },
      );
      // The branch is gone from the remote: forget our copy of it.
      if (fetched.code !== 0) await git(cwd, ["update-ref", "-d", tracking], { allowFailure: true });
    }
    return tryRevParse(cwd, tracking);
  };

  let github: Promise<GitHub | null> | undefined;

  return {
    github: () => (github ??= connectGitHub(forkSlug, credentialEnv(credentials))),
    repo,
    branch,
    remote,
    forkUrl,
    forkSlug,
    fork,
    config,
    rules: compileRules(config),
    upstream: { name, slug, url, branch: config.upstream.branch, tip },
    target,
    base,
    behind: await countCommits(cwd, `${fork}..${target}`),
    credentials,
    remoteGit,
    proposal,
  };
}

/** The Forklift trailers of a commit: present only on merges Forklift published. */
export async function trailers(cwd: string, commit: string): Promise<{ upstream?: string; status?: string }> {
  const { stdout } = await git(cwd, ["log", "-1", "--format=%B", commit]);
  return {
    upstream: /^Forklift-Upstream: (\S+)$/m.exec(stdout)?.[1],
    status: /^Forklift-Status: (\S+)$/m.exec(stdout)?.[1],
  };
}
