import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";
import { z } from "zod";

export const CONFIG_FILENAME = "forklift.yaml";

/** "30m", "12h", "90s", "2d" → milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(text.trim());
  if (!match) throw new Error(`Invalid duration "${text}" (use e.g. 90s, 30m, 12h, 2d)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms"];
  return Math.round(Number(match[1]) * unit);
}

const Duration = z.string().refine(
  (v) => {
    try {
      parseDuration(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a duration like 90s, 30m, 12h or 2d" },
);

const Globs = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((v) => (typeof v === "string" ? [v] : v));

const Upstream = z
  .union([
    z.string().min(1),
    z.object({
      url: z.string().min(1),
      branch: z.string().min(1).optional(),
      remote: z.string().min(1).optional(),
    }),
  ])
  .transform((v) => {
    const o = typeof v === "string" ? { url: v } : v;
    return { url: o.url, branch: o.branch ?? "main", remote: o.remote ?? "upstream" };
  });

const Forbid = z
  .object({
    pattern: z.string().min(1),
    in: Globs.optional(),
    replace: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => {
      try {
        new RegExp(v.pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "pattern is not a valid regular expression" },
  );

const Verify = z
  .union([
    z.string().min(1),
    z.object({ name: z.string().min(1).optional(), run: z.string().min(1) }).strict(),
  ])
  .transform((v) =>
    typeof v === "string" ? { name: v, run: v } : { name: v.name ?? v.run, run: v.run },
  );

/**
 * Built-in agent commands. Each reads its task on stdin and edits files in
 * the current directory. Both are limited to editing files and reading git
 * history: Forklift, not the agent, runs the fork's build and tests.
 */
export const AGENT_PRESETS: Record<string, string> = {
  claude:
    'claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git add:*),Bash(git rm:*)"',
  codex: "codex exec --sandbox workspace-write --skip-git-repo-check -",
};

const Agent = z
  .union([
    z.string().min(1),
    z
      .object({
        run: z.string().min(1),
        timeout: Duration.optional(),
        attempts: z.number().int().min(1).max(5).optional(),
      })
      .strict(),
  ])
  .transform((v) => {
    const o = typeof v === "string" ? { run: v } : v;
    return {
      run: AGENT_PRESETS[o.run.trim()] ?? o.run,
      timeoutMs: parseDuration(o.timeout ?? "30m"),
      attempts: o.attempts ?? 2,
    };
  });

const LandMode = z.enum(["push", "pr"]);

const ConfigSchema = z
  .object({
    upstream: Upstream,
    drop: Globs.default([]),
    ours: Globs.default([]),
    regenerate: z.record(z.string().min(1), z.string().min(1)).default({}),
    forbid: z.array(Forbid).default([]),
    verify: z.array(Verify).default([]),
    verify_timeout: Duration.default("45m"),
    agent: Agent.optional(),
    notes: z.string().optional(),
    land: z
      .object({
        /** A merge no agent touched, with every check passing. */
        clean: LandMode.default("push"),
        /** A merge the agent helped with, with every check passing. */
        resolved: LandMode.default("pr"),
      })
      .strict()
      .default({}),
    sync_branch: z.string().min(1).default("forklift/sync"),
    /** How long to leave a failed sync alone before trying it again. */
    retry_after: Duration.default("12h"),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ForbidRule = Config["forbid"][number];
export type VerifyStep = Config["verify"][number];

export function parseConfig(raw: string, source = CONFIG_FILENAME): Config {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(top level)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${source}:\n${details}`);
  }
  return result.data;
}

export async function loadConfigFile(file: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No ${path.basename(file)} at ${file}. Run \`forklift init\` to create one.`);
    }
    throw err;
  }
  return parseConfig(raw, file);
}

/** "owner/repo" → a clonable URL; anything that already looks like one is kept. */
export function upstreamUrl(spec: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) return `https://github.com/${spec}.git`;
  return spec;
}

/** "owner/repo" for a GitHub URL, otherwise null. */
export function githubSlug(url: string): string | null {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A name for a fork ("owner/repo" or a URL) that is safe as a file or directory name. */
export function safeName(spec: string): string {
  const url = upstreamUrl(spec);
  return (githubSlug(url) ?? url.replace(/^\w+:\/\//, "")).replace(/[^\w.-]+/g, "__");
}

export type PathMatcher = (file: string) => boolean;

export function matcher(globs: string[]): PathMatcher {
  if (globs.length === 0) return () => false;
  // A bare directory name means everything under it.
  const expanded = globs.flatMap((g) => {
    const clean = g.replace(/^\.\//, "").replace(/\/+$/, "");
    return /[*?[\]{}!]/.test(clean) ? [clean] : [clean, `${clean}/**`];
  });
  const isMatch = picomatch(expanded, { dot: true });
  return (file) => isMatch(file);
}

export interface Rules {
  drop: PathMatcher;
  ours: PathMatcher;
  /** The command that regenerates this path, or null. */
  regenerate: (file: string) => string | null;
  /** The rule that settles a conflict on this path without an agent, or null. */
  ruleFor: (file: string) => "drop" | "regenerate" | "ours" | null;
}

export function compileRules(config: Config): Rules {
  const drop = matcher(config.drop);
  const ours = matcher(config.ours);
  const regen = Object.entries(config.regenerate).map(
    ([glob, command]) => [matcher([glob]), command] as const,
  );
  const regenerate = (file: string): string | null => {
    for (const [isMatch, command] of regen) if (isMatch(file)) return command;
    return null;
  };
  return {
    drop,
    ours,
    regenerate,
    ruleFor: (file) => {
      if (drop(file)) return "drop";
      if (regenerate(file) !== null) return "regenerate";
      if (ours(file)) return "ours";
      return null;
    },
  };
}
