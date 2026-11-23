import picomatch from "picomatch";
import { LOCK_FILENAME, MANIFEST_FILENAME } from "./config.js";
import type {
  ForkliftManifest,
  GeneratedPathRule,
  HookConfig,
} from "./schema.js";

export type PathClassification =
  | { kind: "hook"; hooks: HookConfig[] }
  | { kind: "generated"; rule: GeneratedPathRule }
  | { kind: "owned" }
  | { kind: "dropped" }
  | { kind: "upstream" };

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function compileGlob(patterns: string[]): (p: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }));
  return (p: string) => {
    const normalized = normalizeRepoPath(p);
    return matchers.some((m) => m(normalized));
  };
}

export interface PolicyClassifier {
  classify(filePath: string): PathClassification;
  matchingGeneratedRules(changedPaths: string[]): GeneratedPathRule[];
}

/**
 * Precedence: hooks > generated > owned > dropped > upstream (default).
 * forklift.yaml and forklift.lock are always implicitly owned.
 */
export function createPolicyClassifier(
  manifest: ForkliftManifest,
): PolicyClassifier {
  const hookEntries = manifest.hooks.map((hook) => ({
    hook,
    matches: compileGlob(hook.paths),
  }));

  const generatedEntries = manifest.paths.generated.map((rule) => ({
    rule,
    matchesPath: compileGlob(rule.paths),
    matchesTrigger: rule.triggers ? compileGlob(rule.triggers) : null,
  }));

  const ownedPatterns = Array.from(
    new Set([MANIFEST_FILENAME, LOCK_FILENAME, ...manifest.paths.owned]),
  );
  const matchesOwned = compileGlob(ownedPatterns);
  const matchesDropped = compileGlob(manifest.paths.dropped);

  return {
    classify(filePath: string): PathClassification {
      const normalized = normalizeRepoPath(filePath);

      const matchedHooks = hookEntries
        .filter((h) => h.matches(normalized))
        .map((h) => h.hook);
      if (matchedHooks.length > 0) {
        return { kind: "hook", hooks: matchedHooks };
      }

      for (const entry of generatedEntries) {
        if (entry.matchesPath(normalized)) {
          return { kind: "generated", rule: entry.rule };
        }
      }

      if (matchesOwned(normalized)) {
        return { kind: "owned" };
      }

      if (matchesDropped(normalized)) {
        return { kind: "dropped" };
      }

      return { kind: "upstream" };
    },

    matchingGeneratedRules(changedPaths: string[]): GeneratedPathRule[] {
      const normalized = changedPaths.map(normalizeRepoPath);
      const matched: GeneratedPathRule[] = [];
      for (const entry of generatedEntries) {
        const hit = normalized.some(
          (p) =>
            entry.matchesPath(p) ||
            (entry.matchesTrigger ? entry.matchesTrigger(p) : false),
        );
        if (hit) matched.push(entry.rule);
      }
      return matched;
    },
  };
}
