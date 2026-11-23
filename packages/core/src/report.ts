import type { SyncResult } from "./sync.js";

export function formatSyncPrTitle(
  template: string,
  targetLabel: string,
): string {
  return template.replace(/\{\{\s*target\s*\}\}/g, targetLabel);
}

export function formatSyncReport(result: SyncResult): string {
  const shortBase = result.baseSha.slice(0, 7);
  const shortTarget = result.targetSha.slice(0, 7);
  const verifyPassed = result.verifyResults.filter((v) => v.ok).length;
  const verifyTotal = result.verifyResults.length;
  const statusBadge = result.readyToMerge
    ? "✅ Ready to merge"
    : "⚠️ Needs review";

  const lines: string[] = [];
  lines.push(`## Forklift Sync Summary`);
  lines.push("");
  lines.push(
    `Lifting **${result.commitsCount} commits** from \`${result.upstreamRepo}\` (\`${shortBase}..${shortTarget}\`) · **${statusBadge}**`,
  );
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Upstream commits | \`${result.commitsCount}\` |`);
  lines.push(`| Cleanly synced files | \`${result.cleanFiles.length}\` |`);
  lines.push(`| Hooks lifted (AI) | \`${result.liftedFiles.length}\` |`);
  lines.push(
    `| Owned / Dropped shielded | \`${result.ownedShielded.length}\` owned · \`${result.droppedKept.length}\` dropped |`,
  );
  lines.push(`| Brand leaks fixed | \`${result.checkReport.brandLeaksFixed}\` |`);
  lines.push(
    `| Verification gates | \`${verifyPassed}/${verifyTotal}\` passing |`,
  );
  lines.push("");

  if (result.liftedFiles.length > 0 || result.reviewFiles.length > 0) {
    lines.push("### Hooks & Conflict Lifts");
    lines.push("");
    for (const item of result.liftedFiles) {
      const hookTag =
        item.hookIds.length > 0 ? ` (\`${item.hookIds.join("`, `")}\`)` : "";
      lines.push(
        `- 🟡 \`${item.file}\`${hookTag} — **Hook Re-applied** (${item.summary})`,
      );
    }
    for (const item of result.reviewFiles) {
      lines.push(`- 👀 \`${item.file}\` — **Needs Review** (${item.reason})`);
    }
    lines.push("");
  }

  if (result.generatedRuns.length > 0) {
    lines.push("### Generated Artifacts");
    lines.push("");
    for (const gen of result.generatedRuns) {
      lines.push(
        `- ${gen.ok ? "✅" : "❌"} \`${gen.paths.join(", ")}\` via \`${gen.run}\``,
      );
    }
    lines.push("");
  }

  if (result.verifyResults.length > 0) {
    lines.push("### Verification");
    lines.push("");
    for (const v of result.verifyResults) {
      const note = v.repairedByAi ? " *(repaired by AI)*" : "";
      lines.push(
        `- ${v.ok ? "✅" : "❌"} **${v.name}** (\`${v.run}\`) — ${(v.durationMs / 1000).toFixed(1)}s${note}`,
      );
    }
    lines.push("");
  }

  if (
    result.checkReport.brandLeaks.length > 0 ||
    result.checkReport.touchpointDrift.length > 0 ||
    result.checkReport.droppedPresent.length > 0
  ) {
    lines.push("### Guardrails");
    lines.push("");
    if (result.checkReport.brandLeaksFixed > 0) {
      lines.push(
        `- ✅ Auto-patched **${result.checkReport.brandLeaksFixed}** brand leak(s).`,
      );
    }
    const remainingLeaks = result.checkReport.brandLeaks.filter((b) => !b.fixed);
    if (remainingLeaks.length > 0) {
      lines.push(
        `- ❌ **${remainingLeaks.length}** unresolved brand leak(s) remaining:`,
      );
      for (const hit of remainingLeaks.slice(0, 15)) {
        lines.push(
          `  - \`${hit.file}:${hit.line}\` matched \`${hit.matched}\` (rule \`${hit.ruleId}\`)`,
        );
      }
    }
    if (result.checkReport.touchpointDrift.length > 0) {
      lines.push(
        `- ⚠️ **${result.checkReport.touchpointDrift.length}** undeclared touchpoint file(s) outside \`forklift.yaml\`.`,
      );
    }
    lines.push("");
  }

  if (result.recentCommits.length > 0) {
    lines.push("<details>");
    lines.push(
      `<summary>Upstream commits (${result.commitsCount} total, showing latest ${result.recentCommits.length})</summary>`,
    );
    lines.push("");
    for (const commit of result.recentCommits) {
      lines.push(`- ${commit}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push("*Automated by **Forklift** — Heavy lifting for your forks.*");
  return lines.join("\n");
}
