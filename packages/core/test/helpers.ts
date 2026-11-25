import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/git.js";

export interface Fixture {
  root: string;
  /** The project being forked. */
  upstream: string;
  /** The fork's remote (bare). */
  origin: string;
  /** A developer's clone of the fork. */
  fork: string;
  /** Write files (null deletes) and commit them in `dir`. Returns the commit. */
  commit(dir: string, files: Record<string, string | null>, message: string): Promise<string>;
  /** Commit files to the fork and push them to its remote. */
  forkCommit(files: Record<string, string | null>, message: string): Promise<string>;
  /** Write forklift.yaml to the fork and push it. */
  configure(yaml: string): Promise<void>;
  /** Contents of a file on a branch of the fork's remote, or null. */
  read(file: string, ref?: string): Promise<string | null>;
  /** Tracked files on a branch of the fork's remote. */
  files(ref?: string): Promise<string[]>;
  remoteHead(ref?: string): Promise<string | null>;
  /** Write an executable agent script; returns the command to configure. */
  agent(name: string, body: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeFixture(initial: Record<string, string>): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "forklift-test-")));
  const upstream = path.join(root, "upstream");
  const origin = path.join(root, "origin.git");
  const fork = path.join(root, "fork");

  // Keep the developer's own git settings (signing, hooks, templates) out.
  const globalConfig = path.join(root, "gitconfig");
  await fs.writeFile(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.FORKLIFT_HOME = path.join(root, "home");

  const commit: Fixture["commit"] = async (dir, files, message) => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file);
      if (content === null) {
        await fs.rm(target, { force: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  };

  await fs.mkdir(upstream);
  await git(upstream, ["init", "--quiet", "-b", "main"]);
  await commit(upstream, initial, "upstream: initial");
  await git(root, ["clone", "--quiet", "--bare", upstream, origin]);
  await git(root, ["clone", "--quiet", origin, fork]);

  const show = async (ref: string, file: string): Promise<string | null> => {
    const res = await git(origin, ["show", `${ref}:${file}`], { allowFailure: true });
    return res.code === 0 ? res.stdout : null;
  };

  const fixture: Fixture = {
    root,
    upstream,
    origin,
    fork,
    commit,
    async forkCommit(files, message) {
      const sha = await commit(fork, files, message);
      await git(fork, ["push", "--quiet", "origin", "main"]);
      return sha;
    },
    async configure(yaml) {
      await fixture.forkCommit({ "forklift.yaml": `upstream: ${upstream}\n${yaml}` }, "fork: forklift.yaml");
    },
    read: (file, ref = "main") => show(ref, file),
    async files(ref = "main") {
      const { stdout } = await git(origin, ["ls-tree", "-r", "--name-only", ref]);
      return stdout.split("\n").filter(Boolean);
    },
    async remoteHead(ref = "main") {
      const res = await git(origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], { allowFailure: true });
      return res.code === 0 ? res.stdout.trim() : null;
    },
    async agent(name, body) {
      const file = path.join(root, `${name}.mjs`);
      await fs.writeFile(
        file,
        `import fs from "node:fs";\nconst prompt = fs.readFileSync(0, "utf8");\n${body}\n`,
      );
      return `node ${file}`;
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
  return fixture;
}
