import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";

/**
 * GitHub operations, through the `gh` CLI so Forklift holds no token logic of
 * its own. Everything here is optional: on other hosts, or without `gh`,
 * Forklift still pushes branches and prints its report.
 */
export interface GitHub {
  slug: string;
  findPullRequest(head: string, base: string): Promise<PullRequest | null>;
  upsertPullRequest(input: PullRequestInput): Promise<PullRequest>;
  closePullRequest(number: number, comment: string): Promise<void>;
  upsertIssue(title: string, body: string): Promise<string | null>;
  closeIssue(title: string, comment: string): Promise<void>;
}

export interface PullRequest {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** GitHub rejects bodies over 65,536 characters. */
const MAX_BODY = 60_000;

export function clampBody(body: string): string {
  if (body.length <= MAX_BODY) return body;
  return `${body.slice(0, MAX_BODY)}\n\n…report cut to fit GitHub's size limit.`;
}

type Gh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * `gh`, always told which repository to act on and run from a neutral
 * directory: it has no reason to read the configuration of a clone.
 */
function ghWith(env: NodeJS.ProcessEnv): Gh {
  return async (args) => {
    try {
      const result = await run("gh", args, { cwd: os.tmpdir(), env, timeoutMs: 60_000 });
      return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      return { ok: false, stdout: "", stderr: (err as Error).message };
    }
  };
}

async function withBodyFile<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forklift-body-"));
  const file = path.join(dir, "body.md");
  try {
    await fs.writeFile(file, clampBody(body), "utf8");
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Returns null when this repository is not on GitHub or `gh` cannot reach it. */
export async function connectGitHub(slug: string | null, env: NodeJS.ProcessEnv): Promise<GitHub | null> {
  if (!slug) return null;
  const gh = ghWith(env);
  const probe = await gh(["repo", "view", slug, "--json", "name"]);
  if (!probe.ok) return null;

  const findPullRequest = async (head: string, base: string): Promise<PullRequest | null> => {
    const res = await gh(
      ["pr", "list", "-R", slug, "--head", head, "--base", base, "--state", "open", "--json", "number,url,isDraft"],
    );
    if (!res.ok) return null;
    const list = JSON.parse(res.stdout || "[]") as PullRequest[];
    return list[0] ?? null;
  };

  const findIssue = async (title: string): Promise<number | null> => {
    const res = await gh(
      ["issue", "list", "-R", slug, "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title"],
    );
    if (!res.ok) return null;
    const list = JSON.parse(res.stdout || "[]") as { number: number; title: string }[];
    return list.find((issue) => issue.title === title)?.number ?? null;
  };

  return {
    slug,
    findPullRequest,

    async upsertPullRequest(input) {
      const existing = await findPullRequest(input.head, input.base);
      return withBodyFile(input.body, async (file) => {
        if (existing) {
          const edit = await gh(
            ["pr", "edit", String(existing.number), "-R", slug, "--title", input.title, "--body-file", file],
          );
          if (!edit.ok) throw new Error(`Could not update pull request #${existing.number}: ${edit.stderr.trim()}`);
          if (existing.isDraft !== input.draft) {
            await gh(
              ["pr", "ready", String(existing.number), "-R", slug, ...(input.draft ? ["--undo"] : [])],
            );
          }
          return { ...existing, isDraft: input.draft };
        }
        const create = await gh(
          [
            "pr", "create", "-R", slug,
            "--head", input.head, "--base", input.base,
            "--title", input.title, "--body-file", file,
            ...(input.draft ? ["--draft"] : []),
          ],
        );
        if (!create.ok) throw new Error(`Could not open a pull request: ${create.stderr.trim()}`);
        const url = create.stdout.trim().split("\n").pop() ?? "";
        return { number: Number(url.split("/").pop()) || 0, url, isDraft: input.draft };
      });
    },

    async closePullRequest(number, comment) {
      await gh(["pr", "close", String(number), "-R", slug, "--comment", comment]);
    },

    async upsertIssue(title, body) {
      const existing = await findIssue(title);
      return withBodyFile(body, async (file) => {
        if (existing !== null) {
          const edit = await gh(["issue", "edit", String(existing), "-R", slug, "--body-file", file]);
          return edit.ok ? edit.stdout.trim() || `https://github.com/${slug}/issues/${existing}` : null;
        }
        const create = await gh(["issue", "create", "-R", slug, "--title", title, "--body-file", file]);
        return create.ok ? (create.stdout.trim().split("\n").pop() ?? null) : null;
      });
    },

    async closeIssue(title, comment) {
      const existing = await findIssue(title);
      if (existing !== null) {
        await gh(["issue", "close", String(existing), "-R", slug, "--comment", comment]);
      }
    },
  };
}
