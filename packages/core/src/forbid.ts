import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, matcher, type ForbidRule } from "./config.js";
import { readBlobs } from "./git.js";

export interface ForbidHit {
  pattern: string;
  message?: string;
  file: string;
  line: number;
  text: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Text of a file, or null for anything too big or binary to be worth scanning. */
export function asText(bytes: Buffer | null | undefined): string | null {
  if (!bytes || bytes.length > MAX_FILE_BYTES) return null;
  // A NUL byte early on means a binary file.
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return bytes.toString("utf8");
}

export interface CompiledForbid {
  rule: ForbidRule;
  applies: (file: string) => boolean;
  test: RegExp;
  global: RegExp;
}

export function compileForbid(rules: ForbidRule[]): CompiledForbid[] {
  return rules.map((rule) => ({
    rule,
    applies: rule.in ? matcher(rule.in) : () => true,
    test: new RegExp(rule.pattern),
    global: new RegExp(rule.pattern, "g"),
  }));
}

/** Files any rule could apply to. The config names the patterns, so it is never scanned. */
export function forbidCandidates(files: string[], compiled: CompiledForbid[]): string[] {
  if (compiled.length === 0) return [];
  return files.filter((file) => file !== CONFIG_FILENAME && compiled.some((c) => c.applies(file)));
}

export interface ContentCheck {
  /** The content after `replace` rules were applied (unchanged when `fix` is off). */
  content: string;
  hits: ForbidHit[];
  /** Lines changed by `replace` rules. */
  rewritten: number;
}

/**
 * Check one file's content against the rules. Pure: the same answer wherever
 * it runs, which lets the side that publishes a merge re-derive what the side
 * that built it should have done.
 *
 * When `before` is given, matches on lines that version already had are left
 * alone: they are the fork's own, not what a merge brought in.
 */
export function checkContent(
  file: string,
  content: string,
  before: string | null,
  compiled: CompiledForbid[],
  fix: boolean,
): ContentCheck {
  const active = compiled.filter((c) => c.applies(file) && c.test.test(content));
  if (active.length === 0) return { content, hits: [], rewritten: 0 };

  const known = new Map<string, number>();
  for (const line of before?.split("\n") ?? []) {
    if (active.some((c) => c.test.test(line))) known.set(line, (known.get(line) ?? 0) + 1);
  }

  const lines = content.split("\n");
  const hits: ForbidHit[] = [];
  let rewritten = 0;
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i]!;
    if (!active.some((c) => c.test.test(original))) continue;
    const seen = known.get(original) ?? 0;
    if (seen > 0) {
      known.set(original, seen - 1);
      continue;
    }
    let line = original;
    for (const c of active) {
      if (!c.test.test(line)) continue;
      if (fix && c.rule.replace !== undefined) {
        line = line.replace(c.global, c.rule.replace);
        if (!c.test.test(line)) continue;
      }
      hits.push({
        pattern: c.rule.pattern,
        message: c.rule.message,
        file,
        line: i + 1,
        text: line.trim().slice(0, 200),
      });
    }
    if (line !== original) {
      lines[i] = line;
      rewritten++;
    }
  }
  return { content: rewritten > 0 ? lines.join("\n") : content, hits, rewritten };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ScanOptions {
  /** Directory holding the files to scan. */
  dir: string;
  files: string[];
  rules: ForbidRule[];
  /**
   * When set, only report matches that this commit's version of the file does
   * not already have: what a merge newly brought in, not what the fork
   * already carried. `gitEnv` is the environment for the git calls this needs.
   */
  newSince?: string;
  gitEnv?: NodeJS.ProcessEnv;
  /** Rewrite matches of rules that have `replace`, instead of reporting them. */
  fix?: boolean;
}

export interface ScanResult {
  hits: ForbidHit[];
  /** Files rewritten by `replace` rules, with how many lines changed. */
  replaced: { file: string; lines: number }[];
}

/** Scan files on disk. */
export async function scanForbidden(options: ScanOptions): Promise<ScanResult> {
  const compiled = compileForbid(options.rules);
  const result: ScanResult = { hits: [], replaced: [] };
  const candidates = forbidCandidates(options.files, compiled);
  if (candidates.length === 0) return result;

  const contents = await mapLimit(candidates, 32, async (file) => {
    try {
      const stat = await fs.stat(path.join(options.dir, file));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      return asText(await fs.readFile(path.join(options.dir, file)));
    } catch {
      return null;
    }
  });

  // Only files that match at all need their earlier version looked up.
  const matching = candidates.filter((file, i) => {
    const content = contents[i];
    return content != null && compiled.some((c) => c.applies(file) && c.test.test(content));
  });
  const earlier = options.newSince
    ? await readBlobs(options.dir, matching.map((file) => `${options.newSince}:${file}`), { env: options.gitEnv })
    : new Map<string, Buffer | null>();

  for (const file of matching) {
    const content = contents[candidates.indexOf(file)]!;
    const before = options.newSince ? asText(earlier.get(`${options.newSince}:${file}`)) : null;
    const checked = checkContent(file, content, before, compiled, options.fix === true);
    result.hits.push(...checked.hits);
    if (checked.rewritten > 0) {
      await fs.writeFile(path.join(options.dir, file), checked.content, "utf8");
      result.replaced.push({ file, lines: checked.rewritten });
    }
  }
  return result;
}

export function describeHits(hits: ForbidHit[], limit = 40): string {
  const lines = hits
    .slice(0, limit)
    .map((h) => `${h.file}:${h.line}: matches /${h.pattern}/${h.message ? ` (${h.message})` : ""}\n    ${h.text}`);
  if (hits.length > limit) lines.push(`…and ${hits.length - limit} more`);
  return lines.join("\n");
}
