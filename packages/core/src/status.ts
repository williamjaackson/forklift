import { loadLock, loadManifest } from "./config.js";
import {
  countCommits,
  diffNameStatus,
  ensureUpstreamRemote,
  fetchUpstream,
  logOneline,
  readBlob,
  tryRevParse,
} from "./git.js";
import { createPolicyClassifier } from "./policy.js";
import type { HookConfig } from "./schema.js";

export interface AffectedHookStatus {
  hook: HookConfig;
  files: string[];
  missingAnchors: Array<{ file: string; anchor: string }>;
}

export interface StatusReport {
  upstreamRepo: string;
  upstreamRef: string;
  lastSyncedSha: string;
  targetSha: string;
  commitsBehind: number;
  recentCommits: string[];
  counts: {
    upstream: number;
    hooks: number;
    owned: number;
    dropped: number;
    generated: number;
  };
  affectedHooks: AffectedHookStatus[];
}

export interface StatusOptions {
  cwd: string;
  fetch?: boolean;
  targetRef?: string;
}

export async function runStatus(options: StatusOptions): Promise<StatusReport> {
  const { cwd, fetch = true } = options;
  const manifest = await loadManifest(cwd);
  const lock = await loadLock(cwd);
  const { remote, repo, ref } = manifest.upstream;

  let targetSha: string;
  if (options.targetRef) {
    const resolved = await tryRevParse(cwd, options.targetRef);
    if (!resolved) {
      throw new Error(`Could not resolve target ref "${options.targetRef}".`);
    }
    targetSha = resolved;
  } else if (fetch) {
    await ensureUpstreamRemote(cwd, remote, repo);
    targetSha = await fetchUpstream(cwd, remote, ref);
  } else {
    const resolved = await tryRevParse(cwd, `${remote}/${ref}`);
    if (!resolved) {
      throw new Error(
        `Upstream ref "${remote}/${ref}" not found locally. Run without --no-fetch.`,
      );
    }
    targetSha = resolved;
  }

  const baseSha = lock.upstream.sha;
  if (baseSha === targetSha) {
    return {
      upstreamRepo: repo,
      upstreamRef: ref,
      lastSyncedSha: baseSha,
      targetSha,
      commitsBehind: 0,
      recentCommits: [],
      counts: { upstream: 0, hooks: 0, owned: 0, dropped: 0, generated: 0 },
      affectedHooks: [],
    };
  }

  const [commitsBehind, recentCommits, diffs] = await Promise.all([
    countCommits(cwd, baseSha, targetSha),
    logOneline(cwd, baseSha, targetSha, { limit: 10 }),
    diffNameStatus(cwd, baseSha, targetSha),
  ]);

  const classifier = createPolicyClassifier(manifest);
  const counts = { upstream: 0, hooks: 0, owned: 0, dropped: 0, generated: 0 };
  const hookFilesMap = new Map<string, { hook: HookConfig; files: string[] }>();

  for (const entry of diffs) {
    const cls = classifier.classify(entry.path);
    switch (cls.kind) {
      case "hook":
        counts.hooks++;
        for (const hook of cls.hooks) {
          const existing = hookFilesMap.get(hook.id);
          if (existing) {
            existing.files.push(entry.path);
          } else {
            hookFilesMap.set(hook.id, { hook, files: [entry.path] });
          }
        }
        break;
      case "owned":
        counts.owned++;
        break;
      case "dropped":
        counts.dropped++;
        break;
      case "generated":
        counts.generated++;
        break;
      case "upstream":
        counts.upstream++;
        break;
    }
  }

  const affectedHooks: AffectedHookStatus[] = [];
  for (const { hook, files } of hookFilesMap.values()) {
    const missingAnchors: Array<{ file: string; anchor: string }> = [];
    if (hook.anchors && hook.anchors.length > 0) {
      for (const file of files) {
        const blob = await readBlob(cwd, targetSha, file);
        const text = blob ? blob.toString("utf8") : "";
        for (const anchor of hook.anchors) {
          if (!text.includes(anchor)) {
            missingAnchors.push({ file, anchor });
          }
        }
      }
    }
    affectedHooks.push({ hook, files, missingAnchors });
  }

  return {
    upstreamRepo: repo,
    upstreamRef: ref,
    lastSyncedSha: baseSha,
    targetSha,
    commitsBehind,
    recentCommits,
    counts,
    affectedHooks,
  };
}
