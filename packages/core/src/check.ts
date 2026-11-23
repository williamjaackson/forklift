import fs from "node:fs/promises";
import path from "node:path";
import { loadLock, loadManifest } from "./config.js";
import {
  diffNameStatus,
  isBinaryBuffer,
  listTrackedFiles,
  tryRevParse,
} from "./git.js";
import {
  compileGlob,
  createPolicyClassifier,
  normalizeRepoPath,
} from "./policy.js";
import type { BrandLeakRule, ForkliftLock, ForkliftManifest } from "./schema.js";

export interface BrandLeakHit {
  ruleId: string;
  file: string;
  line: number;
  column: number;
  matched: string;
  mode: BrandLeakRule["mode"];
  fixed: boolean;
}

export interface TouchpointDriftHit {
  file: string;
  status: string;
  severity: "warn" | "error";
}

export interface CheckOptions {
  cwd: string;
  manifest?: ForkliftManifest;
  lock?: ForkliftLock | null;
  fix?: boolean;
  files?: string[];
}

export interface CheckReport {
  ok: boolean;
  brandLeaks: BrandLeakHit[];
  brandLeaksFixed: number;
  touchpointDrift: TouchpointDriftHit[];
  droppedPresent: string[];
  errorCount: number;
  warningCount: number;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRuleRegex(rule: BrandLeakRule): RegExp {
  const source = rule.literal ? escapeRegExp(rule.literal) : rule.match!;
  const flags = rule.case_sensitive ? "g" : "gi";
  return new RegExp(source, flags);
}

function findLineCol(content: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline };
}

export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const { cwd, fix = false } = options;
  const manifest = options.manifest ?? (await loadManifest(cwd));
  let lock: ForkliftLock | null = options.lock ?? null;
  if (options.lock === undefined) {
    try {
      lock = await loadLock(cwd);
    } catch {
      lock = null;
    }
  }

  const classifier = createPolicyClassifier(manifest);
  const trackedFiles = (options.files ?? (await listTrackedFiles(cwd))).map(
    normalizeRepoPath,
  );

  // 1. Dropped paths enforcement
  const droppedPresent: string[] = [];
  for (const file of trackedFiles) {
    if (classifier.classify(file).kind === "dropped") {
      const abs = path.join(cwd, file);
      try {
        await fs.access(abs);
        if (fix) {
          await fs.rm(abs, { force: true });
        } else {
          droppedPresent.push(file);
        }
      } catch {
        // Already deleted in working tree
      }
    }
  }

  // 2. Touchpoint drift detection
  const touchpointDrift: TouchpointDriftHit[] = [];
  const tpMode = manifest.guardrails.touchpoints.mode;
  if (tpMode !== "off" && lock) {
    const baseExists = await tryRevParse(cwd, lock.upstream.sha);
    if (baseExists) {
      const diffs = await diffNameStatus(cwd, lock.upstream.sha, "HEAD");
      for (const entry of diffs) {
        const file = normalizeRepoPath(entry.path);
        const cls = classifier.classify(file);
        if (cls.kind === "upstream") {
          touchpointDrift.push({
            file,
            status: entry.status,
            severity: tpMode,
          });
        }
      }
    }
  }

  // 3. Brand-leak scan & optional autofix
  const brandLeaks: BrandLeakHit[] = [];
  let brandLeaksFixed = 0;
  const blConfig = manifest.guardrails.brand_leaks;

  if (blConfig.rules.length > 0) {
    const globalExclude = compileGlob(blConfig.exclude);
    const compiledRules = blConfig.rules.map((rule) => ({
      rule,
      regex: buildRuleRegex(rule),
      include: rule.include ? compileGlob(rule.include) : null,
      exclude: rule.exclude ? compileGlob(rule.exclude) : null,
    }));

    for (const file of trackedFiles) {
      if (globalExclude(file)) continue;
      if (classifier.classify(file).kind === "dropped") continue;

      const applicable = compiledRules.filter((r) => {
        if (r.include && !r.include(file)) return false;
        if (r.exclude && r.exclude(file)) return false;
        return true;
      });
      if (applicable.length === 0) continue;

      const abs = path.join(cwd, file);
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (isBinaryBuffer(buf)) continue;

      let content = buf.toString("utf8");
      let fileModified = false;

      for (const { rule, regex } of applicable) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        const hitsInRule: Array<{ line: number; column: number; matched: string }> = [];

        while ((match = regex.exec(content)) !== null) {
          if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          const { line, column } = findLineCol(content, match.index);
          hitsInRule.push({ line, column, matched: match[0] });
        }

        if (hitsInRule.length === 0) continue;

        const shouldFix =
          fix && rule.mode === "autofix" && rule.replace !== undefined;
        if (shouldFix) {
          regex.lastIndex = 0;
          content = content.replace(regex, rule.replace!);
          fileModified = true;
          brandLeaksFixed += hitsInRule.length;
        }

        for (const h of hitsInRule) {
          brandLeaks.push({
            ruleId: rule.id,
            file,
            line: h.line,
            column: h.column,
            matched: h.matched,
            mode: rule.mode,
            fixed: shouldFix,
          });
        }
      }

      if (fileModified) {
        await fs.writeFile(abs, content, "utf8");
      }
    }
  }

  let errorCount = droppedPresent.length;
  let warningCount = 0;

  for (const tp of touchpointDrift) {
    if (tp.severity === "error") errorCount++;
    else warningCount++;
  }

  for (const hit of brandLeaks) {
    if (hit.fixed) continue;
    if (hit.mode === "warn") warningCount++;
    else errorCount++;
  }

  return {
    ok: errorCount === 0,
    brandLeaks,
    brandLeaksFixed,
    touchpointDrift,
    droppedPresent,
    errorCount,
    warningCount,
  };
}
